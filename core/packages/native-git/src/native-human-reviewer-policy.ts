import type { NativeGitBundleConfig } from "./bundle-config.js";
import type { NativeImportedRootPolicy } from "./native-imported-root-policy.js";
import { NativeProjectRootImportStateError } from "./native-project-root-import-codec.js";

export function assertConfiguredHumanReviewers(
  config: Pick<NativeGitBundleConfig, "humanReviewers">,
  policy: NativeImportedRootPolicy
): void {
  const configured = new Set(config.humanReviewers.map(({ reviewerId }) => reviewerId));
  const required = [
    ...policy.requiredReviewerIds,
    ...policy.pathReviewerRules.flatMap(({ reviewerIds }) => reviewerIds)
  ];
  if (required.some((reviewerId) => !configured.has(reviewerId))) {
    throw new NativeProjectRootImportStateError("native Project root policy references an unavailable human reviewer");
  }
}

export function policyReviewerIds(policy: NativeImportedRootPolicy): ReadonlySet<string> {
  return new Set([
    ...policy.requiredReviewerIds,
    ...policy.pathReviewerRules.flatMap(({ reviewerIds }) => reviewerIds)
  ]);
}
