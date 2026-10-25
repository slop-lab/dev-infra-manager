import { readAuthoritativeNativeDecisions } from "./authoritative-native-decision-store.js";
import { readAuthoritativeNativeReviewRefs } from "./authoritative-native-review-git.js";
import {
  readAuthoritativeNativeReviewEnvelope,
  readAuthoritativeNativeReviewEnvelopes
} from "./authoritative-native-review-store.js";
import {
  nativeHumanReviewStaleReasons,
  nativeHumanReviewSummaryStaleReasons
} from "./native-human-reviewer-freshness.js";
import type {
  ExactReviewRoute,
  HumanReviewerRequestContext,
  RepositoryReviewRoute
} from "./native-human-reviewer-http-types.js";
import { nativeHumanReviewStatus } from "./native-human-reviewer-status.js";
import {
  assertAuthoritativeNativeRepositoryTargetCurrent,
  exactActivationIsBound,
  readNativeProjectRegistrations,
  resolveAuthoritativeNativeRepositoryTarget,
  sendJson,
  sendNotFound
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { nativeRepositoryBranches } from "@slop-lab/dim-contracts-git";

export type ExactReview = {
  readonly target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRepositoryTarget>>;
  readonly envelope: NonNullable<Awaited<ReturnType<typeof readAuthoritativeNativeReviewEnvelope>>>;
  readonly staleReasons: readonly string[];
};

export async function serveExactReview(
  context: HumanReviewerRequestContext,
  route: ExactReviewRoute
): Promise<void> {
  const selected = await inspectExactReview(context, route);
  if (selected === undefined) return;
  const decisions = await readAuthoritativeNativeDecisions(selected.target.repository, route.reviewId);
  sendJson(context.response, 200, {
    status: nativeHumanReviewStatus(selected.envelope.review.requiredReviewerIds, selected.staleReasons, decisions),
    staleReasons: selected.staleReasons,
    ...selected.envelope,
    approvals: decisions.approvals,
    revocations: decisions.revocations
  });
}

export async function inspectExactReview(
  context: HumanReviewerRequestContext,
  route: ExactReviewRoute
): Promise<ExactReview | undefined> {
  const { input, request, response, reviewer } = context;
  const { projectId, repositoryId, reviewId } = route;
  const runtime = { ...input.runtime, authoritativeTargetProofs: new Map() };
  if (!readNativeProjectRegistrations(input.runtime.state)
    .some((entry) => entry.projectId === projectId && entry.repositoryId === repositoryId)) {
    sendNotFound(response);
    return undefined;
  }
  if (request.headers["x-dim-generation-id"] !== input.runtime.expectedGenerationId) {
    sendJson(response, 409, { error: "review generation conflicts with service startup" });
    return undefined;
  }
  if (!input.runtime.activated() || !exactActivationIsBound(
    input.runtime.state,
    input.runtime.expectedGenerationId,
    input.runtime.activationTokenDigest
  )) {
    sendJson(response, 503, { error: "human review proof is unavailable" });
    return undefined;
  }
  let target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRepositoryTarget>>;
  try {
    target = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId, repositoryId });
  } catch (error) {
    if (error instanceof Error) {
      sendJson(response, 503, { error: "human review proof is unavailable" });
      return undefined;
    }
    throw error;
  }
  const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, reviewId);
  if (envelope === undefined || envelope.review.projectId !== projectId || envelope.review.repositoryId !== repositoryId) {
    sendNotFound(response);
    return undefined;
  }
  if (envelope.review.requiredReviewerIds.length > 0
    && !envelope.review.requiredReviewerIds.includes(reviewer.reviewerId)) {
    sendJson(response, 403, { error: "reviewer is not required for this review" });
    return undefined;
  }
  if (target.currentHead.protectedRef !== envelope.review.protectedRef) {
    try {
      target = await resolveAuthoritativeNativeRepositoryTarget(runtime, {
        projectId,
        repositoryId,
        protectedRef: envelope.review.protectedRef
      });
    } catch {
      sendJson(response, 503, { error: "human review proof is unavailable" });
      return undefined;
    }
  }
  const staleReasons = await nativeHumanReviewStaleReasons(runtime, target, envelope.review);
  try {
    await assertAuthoritativeNativeRepositoryTargetCurrent({
      runtime,
      selector: { projectId, repositoryId, protectedRef: envelope.review.protectedRef },
      target
    });
  } catch (error) {
    if (error instanceof Error) {
      sendJson(response, 503, { error: "human review proof is unavailable" });
      return undefined;
    }
    throw error;
  }
  return { target, envelope, staleReasons: [...new Set(staleReasons)] };
}

export async function listReviewSummaries(
  context: HumanReviewerRequestContext,
  route: RepositoryReviewRoute
): Promise<void> {
  const { input, request, response, reviewer } = context;
  const { projectId, repositoryId } = route;
  await input.serialize(async () => {
    const runtime = { ...input.runtime, authoritativeTargetProofs: new Map() };
    if (request.headers["x-dim-generation-id"] !== input.runtime.expectedGenerationId) {
      return sendJson(response, 409, { error: "review generation is stale" });
    }
    if (!input.runtime.activated() || !exactActivationIsBound(
      input.runtime.state, input.runtime.expectedGenerationId, input.runtime.activationTokenDigest
    )) return sendJson(response, 503, { error: "human review is unavailable" });
    let target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRepositoryTarget>>;
    try {
      target = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId, repositoryId });
    } catch {
      return sendNotFound(response);
    }
    const envelopes = (await readAuthoritativeNativeReviewEnvelopes(target.repository))
      .filter((entry) => entry.review.projectId === projectId && entry.review.repositoryId === repositoryId
        && (entry.review.requiredReviewerIds.length === 0
          || entry.review.requiredReviewerIds.includes(reviewer.reviewerId)))
      .sort((left, right) => right.review.createdAt.localeCompare(left.review.createdAt)).slice(0, 100);
    const summaries = [];
    const branchTargets = new Map([[target.currentHead.protectedRef, target]]);
    const managedBranches = nativeRepositoryBranches(target.imported.policy);
    const allDecisions = await readAuthoritativeNativeDecisions(target.repository);
    const currentRefs = new Map<string, ReturnType<typeof readAuthoritativeNativeReviewRefs>>();
    for (const { review } of envelopes) {
      let branchTarget = branchTargets.get(review.protectedRef);
      if (branchTarget === undefined && Object.hasOwn(managedBranches, review.protectedRef)) {
        try {
          branchTarget = await resolveAuthoritativeNativeRepositoryTarget(runtime, {
            projectId,
            repositoryId,
            protectedRef: review.protectedRef
          });
        } catch {
          return sendJson(response, 503, { error: "human review proof is unavailable" });
        }
        branchTargets.set(review.protectedRef, branchTarget);
      }
      const staleReasons = branchTarget === undefined ? ["protected-branch-unmanaged"]
        : review.expectedProtectedHead !== branchTarget.currentHead.commit ? ["protected-head-changed"]
        : review.policyRevision !== branchTarget.imported.policy.policyRevision ? ["policy-changed"]
        : await nativeHumanReviewSummaryStaleReasons(runtime, branchTarget, review, () => {
          const key = JSON.stringify([
            branchTarget.repository,
            branchTarget.currentHead.protectedRef,
            review.proposalRef
          ]);
          let pending = currentRefs.get(key);
          if (pending === undefined) {
            pending = readAuthoritativeNativeReviewRefs({
              gitExecutable: input.runtime.gitExecutable,
              gitIdentity: input.runtime.gitIdentity,
              repository: branchTarget.repository,
              protectedRef: branchTarget.currentHead.protectedRef,
              proposalRef: review.proposalRef,
              signal: AbortSignal.timeout(30_000)
            });
            currentRefs.set(key, pending);
          }
          return pending;
        });
      const decisions = {
        approvals: allDecisions.approvals.filter((approval) => approval.reviewId === review.reviewId),
        revocations: allDecisions.revocations.filter((revocation) => revocation.reviewId === review.reviewId),
        activeApprovals: allDecisions.activeApprovals.filter((approval) => approval.reviewId === review.reviewId)
      };
      summaries.push({
        reviewId: review.reviewId,
        proposalRef: review.proposalRef,
        protectedRef: review.protectedRef,
        candidateCommit: review.candidateCommit,
        createdAt: review.createdAt,
        status: nativeHumanReviewStatus(review.requiredReviewerIds, staleReasons, decisions)
      });
    }
    if (!input.runtime.activated() || !exactActivationIsBound(
      input.runtime.state, input.runtime.expectedGenerationId, input.runtime.activationTokenDigest
    )) return sendJson(response, 503, { error: "human review is unavailable" });
    sendJson(response, 200, summaries);
  });
}
