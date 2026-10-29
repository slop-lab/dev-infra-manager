import { isDeepStrictEqual } from "node:util";
import { candidatePrincipalId, repositorySnapshotsSchema } from "@slop-lab/gs-repository-contracts";
import type { BorrowedRepositoryMutationAccess, RepositoryAccess } from "@slop-lab/gs-repository-service";
import {
  createAuthoritativeNativeReviewEnvelope,
  reviewRequestSchema,
  type AuthoritativeNativeReviewEnvelope,
  type AuthoritativeNativeReviewIdentity,
  type ReviewAttachment,
  type ReviewRequest,
} from "@slop-lab/gs-review-contracts";
import { codeReviewPolicy } from "./policy.js";
import { assertReviewInputsCurrent } from "./review-inputs.js";
import { assertAuthoritativeReviewRefs, inspectAuthoritativeReviewGit } from "./review-git.js";
import { reviewRequirementsForChanges } from "./requirements.js";
import { saveAuthoritativeNativeReviewEnvelope } from "./review-store.js";
import type { ReviewFeatureOptions } from "./types.js";

export type ReviewCreationInput = ReviewRequest & { readonly ownerRequestId?: string };

export async function createReviewInTransaction(input: {
  readonly options: ReviewFeatureOptions;
  readonly access: BorrowedRepositoryMutationAccess;
  readonly request: ReviewCreationInput;
  readonly acceptPreparations: boolean;
}): Promise<AuthoritativeNativeReviewEnvelope> {
  const { ownerRequestId, ...requestValue } = input.request;
  const request = reviewRequestSchema.parse(requestValue);
  assertTargetMatchesRequest(input.access, request);
  assertCurrentEpoch(input.options, input.access.authority.authorityEpoch);
  const target = input.access.target;
  const repositoryAccess: RepositoryAccess = {
    principalId: request.requesterPrincipalId ?? target.ownerPrincipalId,
    target,
  };
  const signal = AbortSignal.timeout(30_000);
  const evidence = await inspectAuthoritativeReviewGit({
    reader: input.options.reader,
    access: repositoryAccess,
    protectedRef: target.head.protectedRef,
    expectedProtectedHead: target.head.commit,
    proposalRef: request.proposalRef,
    signal,
  });
  const requirements = await reviewRequirementsForChanges({
    reader: input.options.reader,
    access: repositoryAccess,
    matchers: input.options.matchers,
    policy: target.policy,
    changes: evidence.changes,
    candidateCommit: evidence.candidateCommit,
    baseCommit: evidence.expectedProtectedHead,
    protectedRef: target.head.protectedRef,
  });
  let identity = initialIdentity(request, target, evidence, requirements, input.options);
  const attachments: ReviewAttachment[] = [];
  for (const preparation of input.options.preparations) {
    const prepared = await preparation.prepare({
      access: input.access,
      request,
      target,
      evidence,
      identity,
    });
    identity = { ...identity, inputs: mergeSnapshots(identity.inputs, prepared.inputs) };
    if (prepared.attachment !== undefined) attachments.push(prepared.attachment);
  }
  const envelope = createAuthoritativeNativeReviewEnvelope({
    identity,
    policyDigest: target.policyDigest,
    attachments,
    createdAt: new Date().toISOString(),
  });
  await input.options.hooks?.beforeFinalVerification?.();
  await input.access.authority.assertCurrent(target);
  assertCurrentEpoch(input.options, input.access.authority.authorityEpoch);
  const currentRequirements = await reviewRequirementsForChanges({
    reader: input.options.reader,
    access: repositoryAccess,
    matchers: input.options.matchers,
    policy: target.policy,
    changes: evidence.changes,
    candidateCommit: evidence.candidateCommit,
    baseCommit: evidence.expectedProtectedHead,
    protectedRef: target.head.protectedRef,
  });
  if (!isDeepStrictEqual(currentRequirements, requirements)
    || codeReviewPolicy(target.policy, input.options.matchers, target.head.protectedRef).requiredReviewRevision
      !== identity.requiredReviewRevision) {
    throw new ReviewCreationError("required review matchers changed during review creation");
  }
  await assertReviewInputsCurrent({ authority: input.access.authority, review: identity });
  for (const preparation of input.options.preparations) {
    const attachment = attachments.find(({ kind }) => kind === preparation.name);
    await preparation.assertCurrent?.({
      authority: input.access.authority,
      review: identity,
      ...(attachment === undefined ? {} : { attachment }),
    });
  }
  await assertAuthoritativeReviewRefs({
    reader: input.options.reader,
    access: repositoryAccess,
    protectedRef: identity.protectedRef,
    proposalRef: identity.proposalRef,
    expectedProtectedHead: identity.expectedProtectedHead,
    candidateCommit: identity.candidateCommit,
    candidateTree: identity.candidateTree,
    signal,
  });
  const publish = async (): Promise<AuthoritativeNativeReviewEnvelope> => {
    await input.options.hooks?.beforePublication?.({ repository: target.repositoryPath, envelope });
    return saveAuthoritativeNativeReviewEnvelope(target.repositoryPath, envelope);
  };
  const published = input.options.hooks?.publish === undefined
    ? await publish()
    : await input.options.hooks.publish({ repository: target.repositoryPath, envelope }, publish);
  if (!input.acceptPreparations) return published;
  try {
    for (const preparation of input.options.preparations) {
      await preparation.accepted?.({
        authority: input.access.authority,
        envelope: published,
        ownerRequestId: ownerRequestId ?? `review:${published.review.reviewId}`,
      });
    }
    await input.options.hooks?.acceptanceCompleted?.({ target, envelope: published });
  } catch (cause) {
    await input.options.hooks?.acceptanceFailed?.({ target, envelope: published, cause });
    throw cause;
  }
  return published;
}

function initialIdentity(
  request: ReviewRequest,
  target: BorrowedRepositoryMutationAccess["target"],
  evidence: Awaited<ReturnType<typeof inspectAuthoritativeReviewGit>>,
  requirements: Awaited<ReturnType<typeof reviewRequirementsForChanges>>,
  options: ReviewFeatureOptions,
): AuthoritativeNativeReviewIdentity {
  const requiredReviewRevision = codeReviewPolicy(target.policy, options.matchers, target.head.protectedRef).requiredReviewRevision;
  return {
    schemaVersion: 2,
    serviceId: "native-main",
    projectId: request.namespaceId,
    repositoryId: request.repositoryId,
    inputs: { [request.repositoryId]: { commit: evidence.candidateCommit, tree: evidence.candidateTree } },
    protectedRef: target.head.protectedRef,
    proposalRef: request.proposalRef,
    ...evidence,
    policyRevision: target.policy.policyRevision,
    requiredReviewRevision,
    ...(candidatePrincipalId(request.proposalRef) === undefined ? {} : {
      workspaceId: candidatePrincipalId(request.proposalRef),
    }),
    requiredReviewerIds: requirements.reviewerIds,
    ...(requirements.evidence.length === 0 ? {} : { changeRuleEvidence: requirements.evidence }),
  };
}

function mergeSnapshots(left: AuthoritativeNativeReviewIdentity["inputs"], right: Readonly<Record<string, {
  readonly commit: string;
  readonly tree: string;
}>>): AuthoritativeNativeReviewIdentity["inputs"] {
  const combined = { ...left };
  for (const [repositoryId, snapshot] of Object.entries(right)) {
    const previous = combined[repositoryId];
    if (previous !== undefined && !isDeepStrictEqual(previous, snapshot)) {
      throw new ReviewCreationError("review preparations returned conflicting repository snapshots");
    }
    combined[repositoryId] = snapshot;
  }
  return repositorySnapshotsSchema.parse(Object.fromEntries(
    Object.entries(combined).sort(([leftId], [rightId]) => leftId.localeCompare(rightId)),
  ));
}

function assertTargetMatchesRequest(access: BorrowedRepositoryMutationAccess, request: ReviewRequest): void {
  if (access.target.selector.namespaceId !== request.namespaceId
    || access.target.selector.repositoryId !== request.repositoryId
    || (request.protectedRef !== undefined && access.target.head.protectedRef !== request.protectedRef)) {
    throw new ReviewCreationError("borrowed repository target conflicts with the review request");
  }
}

export function assertCurrentEpoch(options: ReviewFeatureOptions, authorityEpoch: string): void {
  if (options.currentAuthorityEpoch() !== authorityEpoch) {
    throw new ReviewCreationError("repository authority epoch is stale");
  }
}

export class ReviewCreationError extends Error {
  readonly name = "ReviewCreationError";
}
