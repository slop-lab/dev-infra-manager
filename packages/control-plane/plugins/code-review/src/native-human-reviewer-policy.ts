import type { CodeReviewConfig } from "./config.js";
import { codeReviewPolicy } from "./policy.js";
import type { NativeImportedRootPolicy } from "@slop-lab/dim-control-plane-plugin-git-repositories/extensions";
import { NativeProjectRootImportStateError } from "@slop-lab/dim-control-plane-plugin-git-repositories/extensions";

export function assertConfiguredHumanReviewers(
  config: Pick<CodeReviewConfig, "humanReviewers">,
  policy: NativeImportedRootPolicy
): void {
  const configured = new Set(config.humanReviewers.map(({ reviewerId }) => reviewerId));
  const required = [
    ...codeReviewPolicy(policy).requiredReviewerIds,
    ...codeReviewPolicy(policy).pathReviewerRules.flatMap(({ reviewerIds }) => reviewerIds)
  ];
  if (required.some((reviewerId) => !configured.has(reviewerId))) {
    throw new NativeProjectRootImportStateError("native Project root policy references an unavailable human reviewer");
  }
}

export function policyReviewerIds(policy: NativeImportedRootPolicy): ReadonlySet<string> {
  return new Set([
    ...codeReviewPolicy(policy).requiredReviewerIds,
    ...codeReviewPolicy(policy).pathReviewerRules.flatMap(({ reviewerIds }) => reviewerIds)
  ]);
}
