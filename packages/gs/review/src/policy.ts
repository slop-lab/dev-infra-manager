import { createHash } from "node:crypto";
import {
  repositoryBranchPolicy,
  repositoryBranches,
  type RepositoryPolicy,
} from "@slop-lab/gs-repository-contracts";
import { z } from "zod";
import type { PolicySectionOwner } from "@slop-lab/gs-repository-service";
import { assertReviewChangeMatchers, type ReviewChangeMatcher } from "./change-matchers.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const pathRule = z.object({
  pathPrefix: z.string().min(1).max(1024).refine((value) => !value.startsWith("/")
    && !value.includes("\0") && !value.includes("//")
    && value.split("/").every((part) => part !== "." && part !== "..")),
  reviewerIds: z.array(identifier).min(1).readonly(),
}).strict().readonly();
const changeRule = z.object({
  matcher: identifier,
  options: z.unknown(),
  reviewerIds: z.array(identifier).min(1).readonly(),
}).strict().readonly();

export const codeReviewPolicySchema = z.object({
  requiredReviewerIds: z.array(identifier).readonly(),
  pathReviewerRules: z.array(pathRule).readonly(),
  changeReviewerRules: z.array(changeRule).readonly().default([]),
}).strict().readonly();

export const codeReviewPolicySectionOwner: PolicySectionOwner<z.infer<typeof codeReviewPolicySchema>> = {
  sectionName: "code-review",
  enforcement: "authorization",
  parse(value) { return codeReviewPolicySchema.parse(value); },
};

export function codeReviewPolicy(
  policy: RepositoryPolicy,
  matchers: readonly ReviewChangeMatcher[],
  protectedRef?: string,
) {
  assertReviewChangeMatchers(matchers);
  const configured = policy.extensions["code-review"];
  if (configured === undefined) {
    const reviewRequired = protectedRef === undefined
      ? Object.values(repositoryBranches(policy)).some(({ review }) => review)
      : repositoryBranchPolicy(policy, protectedRef).review;
    if (!reviewRequired) return emptyPolicy(policy.policyRevision);
    throw new CodeReviewPolicyError("Repository review policy is missing. Configure policy.code-review with reviewers and review-sensitive paths before reviewing this branch");
  }
  const parsed = codeReviewPolicySchema.safeParse(configured);
  if (!parsed.success) throw new CodeReviewPolicyError("Repository review policy is invalid. Correct policy.code-review reviewer and rule declarations before reviewing this branch", { cause: parsed.error });
  for (const values of [
    parsed.data.requiredReviewerIds,
    ...parsed.data.pathReviewerRules.map((entry) => entry.reviewerIds),
    ...parsed.data.changeReviewerRules.map((entry) => entry.reviewerIds),
  ]) {
    if (new Set(values).size !== values.length) throw new CodeReviewPolicyError("reviewer identities must be unique");
  }
  const selected = [...new Set(parsed.data.changeReviewerRules.map(({ matcher }) => matcher))]
    .sort()
    .map((name) => {
      const provider = matchers.find((entry) => entry.name === name);
      if (provider === undefined) throw new CodeReviewPolicyError(`required review change matcher '${name}' is unavailable`);
      for (const rule of parsed.data.changeReviewerRules.filter((entry) => entry.matcher === name)) {
        provider.validate(rule.options);
      }
      return { name, revision: provider.revision };
    });
  const requiredReviewRevision = selected.length === 0 ? policy.policyRevision
    : createHash("sha256").update(JSON.stringify({ policyRevision: policy.policyRevision, matchers: selected })).digest("hex");
  if (protectedRef !== undefined && !repositoryBranchPolicy(policy, protectedRef).review) {
    return emptyPolicy(requiredReviewRevision);
  }
  return { ...parsed.data, requiredReviewRevision };
}

function emptyPolicy(requiredReviewRevision: string) {
  return {
    requiredReviewerIds: [],
    pathReviewerRules: [],
    changeReviewerRules: [],
    requiredReviewRevision,
  } as const;
}

export class CodeReviewPolicyError extends Error {
  readonly name = "CodeReviewPolicyError";
}
