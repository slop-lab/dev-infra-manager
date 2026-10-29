import type { RepositoryPolicy } from "@slop-lab/gs-repository-contracts";
import {
  codeReviewPolicy as gsCodeReviewPolicy,
  codeReviewPolicySchema,
  CodeReviewPolicyError,
  defaultReviewChangeMatchers,
  type ReviewChangeMatcher,
} from "@slop-lab/gs-review";

export { codeReviewPolicySchema, CodeReviewPolicyError };

export function codeReviewPolicy(
  policy: RepositoryPolicy,
  matchers: readonly ReviewChangeMatcher[] = defaultReviewChangeMatchers(),
  protectedRef?: string,
) {
  return gsCodeReviewPolicy(policy, matchers, protectedRef);
}
