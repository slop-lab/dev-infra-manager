import { createHash } from "node:crypto";
import { assertReviewChangeMatchers, defaultReviewChangeMatchers, type ReviewChangeMatcher } from "./change-matchers.js";
import { z } from "zod";
import { nativeRepositoryBranchPolicy, nativeRepositoryBranches, type NativeImportedRootPolicy } from "@slop-lab/dim-contracts-git";
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const pathRule = z.object({ pathPrefix: z.string().min(1).max(1024).refine((value) => !value.startsWith("/") && !value.includes("\0") && !value.includes("//") && value.split("/").every((part) => part !== "." && part !== "..")), reviewerIds: z.array(identifier).min(1).readonly() }).strict().readonly();
const changeRule = z.object({ matcher: identifier, options: z.unknown(), reviewerIds: z.array(identifier).min(1).readonly() }).strict().readonly();
export const codeReviewPolicySchema = z.object({ requiredReviewerIds: z.array(identifier).readonly(), pathReviewerRules: z.array(pathRule).readonly(), changeReviewerRules: z.array(changeRule).readonly().default([]) }).strict().readonly();
export function codeReviewPolicy(policy: NativeImportedRootPolicy, matchers: readonly ReviewChangeMatcher[] = defaultReviewChangeMatchers(), protectedRef?: string) {
  assertReviewChangeMatchers(matchers);
  const configured = policy.extensions["code-review"];
  if (configured === undefined) {
    const reviewRequired = protectedRef === undefined ? Object.values(nativeRepositoryBranches(policy)).some(({ review }) => review)
      : nativeRepositoryBranchPolicy(policy, protectedRef).review;
    if (!reviewRequired) return { requiredReviewerIds: [], pathReviewerRules: [], changeReviewerRules: [], requiredReviewRevision: policy.policyRevision };
    throw new CodeReviewPolicyError("Repository review policy is missing. Configure policy.code-review with reviewers and review-sensitive paths before reviewing this branch");
  }
  const result = codeReviewPolicySchema.safeParse(configured);
  if (!result.success) throw new CodeReviewPolicyError("Repository review policy is invalid. Correct policy.code-review reviewer and rule declarations before reviewing this branch");
  const parsed = result.data;
  for (const values of [parsed.requiredReviewerIds, ...parsed.pathReviewerRules.map((entry) => entry.reviewerIds), ...parsed.changeReviewerRules.map((entry) => entry.reviewerIds)]) {
    if (new Set(values).size !== values.length) throw new Error("reviewer identities must be unique");
  }
  const selected = [...new Set(parsed.changeReviewerRules.map(({ matcher }) => matcher))].sort().map((name) => {
    const provider = matchers.find((entry) => entry.name === name);
    if (provider === undefined) throw new Error(`required review change matcher '${name}' is unavailable`);
    for (const rule of parsed.changeReviewerRules.filter((entry) => entry.matcher === name)) provider.validate(rule.options);
    return { name, revision: provider.revision };
  });
  const requiredReviewRevision = selected.length === 0 ? policy.policyRevision
    : createHash("sha256").update(JSON.stringify({ policyRevision: policy.policyRevision, matchers: selected })).digest("hex");
  if (protectedRef !== undefined && !nativeRepositoryBranchPolicy(policy, protectedRef).review) {
    return { requiredReviewerIds: [], pathReviewerRules: [], changeReviewerRules: [], requiredReviewRevision };
  }
  return { ...parsed, requiredReviewRevision };
}

export class CodeReviewPolicyError extends Error { readonly name = "CodeReviewPolicyError"; }
