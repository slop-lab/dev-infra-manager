import { assertReviewInputsCurrent } from "./review-inputs.js";
import { inspectAuthoritativeNativeReviewGit, readAuthoritativeNativeReviewRefs } from "./authoritative-native-review-git.js";
import { isDeepStrictEqual } from "node:util";
import type { AuthoritativeNativeReview } from "./authoritative-native-review-schema.js";
import { codeReviewPolicy } from "./policy.js";
import type { CodeReviewRuntime } from "./plugin-api.js";
import { reviewRequirementsForChanges } from "./authoritative-native-review.js";
import type { AuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";

export async function nativeHumanReviewStaleReasons(
  runtime: CodeReviewRuntime,
  target: AuthoritativeNativeRepositoryTarget,
  review: AuthoritativeNativeReview
): Promise<readonly string[]> {
  const reasons: string[] = [];
  const policy = target.imported.policy;
  try {
    if (review.policyRevision !== policy.policyRevision
      || review.requiredReviewRevision !== codeReviewPolicy(policy, runtime.reviewChangeMatchers, review.protectedRef).requiredReviewRevision) reasons.push("policy-changed");
  } catch { reasons.push("review-matcher-unavailable"); }
  if (review.expectedProtectedHead !== target.currentHead.commit) reasons.push("protected-head-changed");
  try { await assertReviewInputsCurrent(runtime, review); }
  catch { reasons.push("repository-inputs-changed"); }
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
    const requirements = await reviewRequirementsForChanges(runtime, policy, evidence.changes, target.repository, evidence.candidateCommit, evidence.expectedProtectedHead, review.protectedRef);
    if (review.projectId !== target.imported.projectId || review.repositoryId !== target.imported.repositoryId
      || review.protectedRef !== target.currentHead.protectedRef || review.workspaceId !== workspaceId
      || review.patch !== evidence.patch || review.patchBytes !== evidence.patchBytes
      || !isDeepStrictEqual(review.changes, evidence.changes)
      || !isDeepStrictEqual(review.requiredReviewerIds, requirements.reviewerIds)
      || !isDeepStrictEqual(review.changeRuleEvidence ?? [], requirements.evidence)) {
      reasons.push("review-identity-changed");
    }
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
