import { isDeepStrictEqual } from "node:util";
import { candidatePrincipalId } from "@slop-lab/gs-repository-contracts";
import type {
  RepositoryAccess,
  RepositoryAuthority,
  RepositoryReadService,
  RepositoryTarget,
} from "@slop-lab/gs-repository-service";
import type { AuthoritativeNativeReviewEnvelope } from "@slop-lab/gs-review-contracts";
import type { ReviewChangeMatcher } from "./change-matchers.js";
import { codeReviewPolicy } from "./policy.js";
import { assertReviewInputsCurrent } from "./review-inputs.js";
import { inspectAuthoritativeReviewGit, readAuthoritativeReviewRefs } from "./review-git.js";
import { reviewRequirementsForChanges } from "./requirements.js";
import type { ReviewPreparation } from "./types.js";

export async function reviewStaleReasons(input: {
  readonly authority: RepositoryAuthority;
  readonly reader: RepositoryReadService;
  readonly matchers: readonly ReviewChangeMatcher[];
  readonly preparations: readonly ReviewPreparation[];
  readonly target: RepositoryTarget;
  readonly envelope: AuthoritativeNativeReviewEnvelope;
  readonly principalId: string;
  readonly requirePreparationProviders?: boolean;
}): Promise<readonly string[]> {
  const { review } = input.envelope;
  const reasons = policyStaleReasons(input.target, input.matchers, review);
  try {
    await assertReviewInputsCurrent({ authority: input.authority, review });
  } catch (error) {
    if (error instanceof Error) reasons.push("repository-inputs-changed");
    else throw error;
  }
  const access: RepositoryAccess = { principalId: input.principalId, target: input.target };
  const signal = AbortSignal.timeout(30_000);
  try {
    const refs = await readAuthoritativeReviewRefs({
      reader: input.reader,
      access,
      protectedRef: input.target.head.protectedRef,
      proposalRef: review.proposalRef,
      signal,
    });
    if (refs.protectedHead !== review.expectedProtectedHead) reasons.push("protected-head-changed");
    if (refs.candidateCommit !== review.candidateCommit) reasons.push("candidate-commit-changed");
    if (refs.candidateTree !== review.candidateTree) reasons.push("candidate-tree-changed");
    if (reasons.length === 0) {
      const evidence = await inspectAuthoritativeReviewGit({
        reader: input.reader,
        access,
        protectedRef: input.target.head.protectedRef,
        expectedProtectedHead: input.target.head.commit,
        proposalRef: review.proposalRef,
        signal,
      });
      const requirements = await reviewRequirementsForChanges({
        reader: input.reader,
        access,
        matchers: input.matchers,
        policy: input.target.policy,
        changes: evidence.changes,
        candidateCommit: evidence.candidateCommit,
        baseCommit: evidence.expectedProtectedHead,
        protectedRef: review.protectedRef,
      });
      if (review.projectId !== input.target.selector.namespaceId
        || review.repositoryId !== input.target.selector.repositoryId
        || review.protectedRef !== input.target.head.protectedRef
        || review.workspaceId !== candidatePrincipalId(review.proposalRef)
        || review.patch !== evidence.patch || review.patchBytes !== evidence.patchBytes
        || !isDeepStrictEqual(review.changes, evidence.changes)
        || !isDeepStrictEqual(review.requiredReviewerIds, requirements.reviewerIds)
        || !isDeepStrictEqual(review.changeRuleEvidence ?? [], requirements.evidence)) {
        reasons.push("review-identity-changed");
      }
    }
  } catch (error) {
    if (error instanceof Error) reasons.push("candidate-ref-unavailable");
    else throw error;
  }
  await assertPreparationsCurrent(input, reasons);
  return [...new Set(reasons)];
}

function policyStaleReasons(
  target: RepositoryTarget,
  matchers: readonly ReviewChangeMatcher[],
  review: AuthoritativeNativeReviewEnvelope["review"],
): string[] {
  const reasons: string[] = [];
  try {
    if (review.policyRevision !== target.policy.policyRevision
      || review.requiredReviewRevision !== codeReviewPolicy(target.policy, matchers, review.protectedRef).requiredReviewRevision) {
      reasons.push("policy-changed");
    }
  } catch (error) {
    if (error instanceof Error) reasons.push("review-matcher-unavailable");
    else throw error;
  }
  if (review.expectedProtectedHead !== target.head.commit) reasons.push("protected-head-changed");
  return reasons;
}

async function assertPreparationsCurrent(
  input: Parameters<typeof reviewStaleReasons>[0],
  reasons: string[],
): Promise<void> {
  for (const attachment of input.envelope.attachments) {
    if (input.requirePreparationProviders !== false
      && !input.preparations.some(({ name }) => name === attachment.kind)) {
      reasons.push("review-preparation-unavailable");
    }
  }
  for (const preparation of input.preparations) {
    const attachment = input.envelope.attachments.find(({ kind }) => kind === preparation.name);
    try {
      await preparation.assertCurrent?.({
        authority: input.authority,
        review: input.envelope.review,
        ...(attachment === undefined ? {} : { attachment }),
      });
    } catch (error) {
      if (error instanceof Error) reasons.push("review-preparation-stale");
      else throw error;
    }
  }
}
