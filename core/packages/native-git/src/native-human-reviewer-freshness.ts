import { inspectAuthoritativeNativeReviewGit, readAuthoritativeNativeReviewRefs } from "./authoritative-native-review-git.js";
import { authoritativeNativeReviewDigest, type AuthoritativeNativeReview } from "./authoritative-native-review-schema.js";
import { requiredReviewers } from "./authoritative-native-review.js";
import type { AuthoritativeNativeCandidateRuntime, AuthoritativeNativeRootTarget } from "./authoritative-native-root-target.js";

export async function nativeHumanReviewStaleReasons(
  runtime: AuthoritativeNativeCandidateRuntime,
  target: AuthoritativeNativeRootTarget,
  review: AuthoritativeNativeReview
): Promise<readonly string[]> {
  const reasons: string[] = [];
  const policy = target.imported.policy;
  if (review.policyDigest !== target.imported.policyDigest
    || review.policyRevision !== policy.policyRevision
    || review.requiredReviewRevision !== policy.requiredReviewRevision
    || review.requiredJobSetRevision !== policy.requiredJobSetRevision) reasons.push("policy-changed");
  if (review.expectedProtectedHead !== target.currentHead.commit) reasons.push("protected-head-changed");
  const git = { gitExecutable: runtime.gitExecutable, gitIdentity: runtime.gitIdentity,
    repository: target.repository, signal: AbortSignal.timeout(30_000),
    protectedRef: target.currentHead.protectedRef, proposalRef: review.proposalRef };
  try {
    const refs = await readAuthoritativeNativeReviewRefs(git);
    if (refs.protectedHead !== review.expectedProtectedHead) reasons.push("protected-head-changed");
    if (refs.candidateCommit !== review.candidateCommit) reasons.push("candidate-commit-changed");
    if (refs.candidateTree !== review.candidateTree) reasons.push("candidate-tree-changed");
    if (reasons.length > 0) return [...new Set(reasons)];
    const evidence = await inspectAuthoritativeNativeReviewGit({ ...git,
      expectedProtectedHead: target.currentHead.commit });
    const workspaceId = /^refs\/heads\/proposals\/([A-Za-z0-9_-]{43})\//.exec(review.proposalRef)?.[1];
    if (workspaceId === undefined) return ["review-identity-changed"];
    const requiredJobs = policy.requiredJobs.map(({ name, kind, evidenceClass }) => ({
      executionKind: kind, jobName: name, evidenceClass
    })).sort((left, right) => left.executionKind.localeCompare(right.executionKind)
      || left.jobName.localeCompare(right.jobName));
    const identity = { schemaVersion: 1 as const, serviceId: "native-main" as const,
      projectId: target.imported.projectId, repositoryId: "root" as const,
      protectedRef: policy.protectedRef, proposalRef: review.proposalRef, ...evidence,
      policyRevision: policy.policyRevision, requiredReviewRevision: policy.requiredReviewRevision,
      requiredJobSetRevision: policy.requiredJobSetRevision, policyDigest: target.imported.policyDigest,
      workspaceId, requiredJobs, requiredReviewerIds: requiredReviewers(policy, evidence.changes) };
    if (authoritativeNativeReviewDigest(identity) !== review.reviewId) reasons.push("review-identity-changed");
    const currentRefs = await readAuthoritativeNativeReviewRefs(git);
    if (currentRefs.protectedHead !== evidence.expectedProtectedHead) reasons.push("protected-head-changed");
    if (currentRefs.candidateCommit !== evidence.candidateCommit) reasons.push("candidate-commit-changed");
    if (currentRefs.candidateTree !== evidence.candidateTree) reasons.push("candidate-tree-changed");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    reasons.push("candidate-ref-unavailable");
  }
  return [...new Set(reasons)];
}
