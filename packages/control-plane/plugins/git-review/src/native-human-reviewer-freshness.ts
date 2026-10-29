import { isDeepStrictEqual } from "node:util";
import { assertReviewInputsCurrent, codeReviewPolicy } from "@slop-lab/gs-review";
import type { AuthoritativeNativeReview, AuthoritativeNativeReviewEnvelope } from "@slop-lab/gs-review-contracts";
import type { AuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { readAuthoritativeNativeReviewRefs } from "./authoritative-native-review-git.js";
import { createDetachedGsReviewExecution } from "./gs-review-runtime.js";
import type { CodeReviewRuntime } from "./plugin-api.js";
import { readAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";

export async function nativeHumanReviewStaleReasons(
  runtime: CodeReviewRuntime,
  target: AuthoritativeNativeRepositoryTarget,
  review: AuthoritativeNativeReview,
  envelopeInput?: AuthoritativeNativeReviewEnvelope,
): Promise<readonly string[]> {
  try {
    const execution = await createDetachedGsReviewExecution(runtime, {
      namespaceId: review.projectId,
      repositoryId: review.repositoryId,
      protectedRef: review.protectedRef,
    });
    const envelope = envelopeInput
      ?? await readAuthoritativeNativeReviewEnvelope(target.repository, review.reviewId);
    if (envelope === undefined) return ["candidate-ref-unavailable"];
    const reasons = [...await execution.feature.staleReasons(
      execution.access.authority,
      execution.access.target,
      envelope,
    )];
    if (execution.access.target.repositoryPath !== target.repository || !isDeepStrictEqual(envelope.review, review)) {
      reasons.push("review-identity-changed");
    }
    return [...new Set(reasons)];
  } catch (error) {
    if (error instanceof Error) return ["candidate-ref-unavailable"];
    throw error;
  }
}

export async function nativeHumanReviewSummaryStaleReasons(
  runtime: CodeReviewRuntime,
  target: AuthoritativeNativeRepositoryTarget,
  review: AuthoritativeNativeReview,
  readRefs?: () => ReturnType<typeof readAuthoritativeNativeReviewRefs>,
): Promise<readonly string[]> {
  const reasons: string[] = [];
  try {
    if (review.policyRevision !== target.imported.policy.policyRevision
      || review.requiredReviewRevision !== codeReviewPolicy(
        target.imported.policy,
        runtime.reviewChangeMatchers ?? [],
        review.protectedRef,
      ).requiredReviewRevision) reasons.push("policy-changed");
  } catch (error) {
    if (error instanceof Error) reasons.push("review-matcher-unavailable");
    else throw error;
  }
  if (review.expectedProtectedHead !== target.currentHead.commit) reasons.push("protected-head-changed");
  if (review.projectId !== target.imported.projectId || review.repositoryId !== target.imported.repositoryId
    || review.protectedRef !== target.currentHead.protectedRef) reasons.push("review-identity-changed");
  if (reasons.length > 0) return [...new Set(reasons)];
  try {
    const execution = await createDetachedGsReviewExecution(runtime, {
      namespaceId: review.projectId,
      repositoryId: review.repositoryId,
      protectedRef: review.protectedRef,
    });
    await assertReviewInputsCurrent({ authority: execution.access.authority, review });
  } catch (error) {
    if (error instanceof Error) reasons.push("repository-inputs-changed");
    else throw error;
  }
  try {
    const refs = await (readRefs?.() ?? readAuthoritativeNativeReviewRefs({
      gitExecutable: runtime.gitExecutable,
      gitIdentity: runtime.gitIdentity,
      repository: target.repository,
      signal: AbortSignal.timeout(30_000),
      protectedRef: target.currentHead.protectedRef,
      proposalRef: review.proposalRef,
    }));
    if (refs.protectedHead !== review.expectedProtectedHead) reasons.push("protected-head-changed");
    if (refs.candidateCommit !== review.candidateCommit) reasons.push("candidate-commit-changed");
    if (refs.candidateTree !== review.candidateTree) reasons.push("candidate-tree-changed");
  } catch (error) {
    if (error instanceof Error) reasons.push("candidate-ref-unavailable");
    else throw error;
  }
  return [...new Set(reasons)];
}
