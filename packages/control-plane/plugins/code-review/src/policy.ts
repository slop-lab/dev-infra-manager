import { z } from "zod";
import type { NativeImportedRootPolicy } from "@slop-lab/dim-contracts-git";
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const pathRule = z.object({ pathPrefix: z.string().min(1).max(1024).refine((value) => !value.startsWith("/") && !value.includes("\0") && !value.includes("//") && value.split("/").every((part) => part !== "." && part !== "..")), reviewerIds: z.array(identifier).min(1).readonly() }).strict().readonly();
export const codeReviewPolicySchema = z.object({ requiredReviewerIds: z.array(identifier).min(1).readonly(), pathReviewerRules: z.array(pathRule).readonly() }).strict().readonly();
export function codeReviewPolicy(policy: NativeImportedRootPolicy) {
  const parsed = codeReviewPolicySchema.parse(policy.extensions["code-review"]);
  for (const values of [parsed.requiredReviewerIds, ...parsed.pathReviewerRules.map((entry) => entry.reviewerIds)]) {
    if (new Set(values).size !== values.length) throw new Error("reviewer identities must be unique");
  }
  return { ...parsed, requiredReviewRevision: policy.policyRevision };
}
