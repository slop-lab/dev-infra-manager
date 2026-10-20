import type { ReviewChangeMatcher } from "./change-matchers.js";
import type { CodeReviewConfig } from "./config.js";
import { codeReviewPolicy } from "./policy.js";
import type { NativeImportedRootPolicy } from "@slop-lab/dim-control-plane-plugin-git-repositories/extensions";
import { NativeProjectRootImportStateError } from "@slop-lab/dim-control-plane-plugin-git-repositories/extensions";

export function assertConfiguredHumanReviewers(
  config: Pick<CodeReviewConfig, "humanReviewers">,
  policy: NativeImportedRootPolicy,
  matchers?: readonly ReviewChangeMatcher[]
): void {
  const configured = new Set(config.humanReviewers.map(({ reviewerId }) => reviewerId));
  const required = [...policyReviewerIds(policy, matchers)];
  if (required.some((reviewerId) => !configured.has(reviewerId))) {
    throw new NativeProjectRootImportStateError("native Project root policy references an unavailable human reviewer");
  }
}

export function policyReviewerIds(policy: NativeImportedRootPolicy, matchers?: readonly ReviewChangeMatcher[]): ReadonlySet<string> {
  const reviewed = codeReviewPolicy(policy, matchers);
  return new Set([
    ...reviewed.requiredReviewerIds,
    ...reviewed.pathReviewerRules.flatMap(({ reviewerIds }) => reviewerIds),
    ...reviewed.changeReviewerRules.flatMap(({ reviewerIds }) => reviewerIds)
  ]);
}
