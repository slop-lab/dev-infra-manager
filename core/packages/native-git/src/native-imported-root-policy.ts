import { createHash } from "node:crypto";
import { z } from "zod";
import { nativeGitReviewPolicySchema, type NativeGitReviewPolicy } from "./config.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const jobName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const revisionValue = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/);
const protectedRef = z.string().max(1024).refine((value) => value.startsWith("refs/heads/")
  && !value.startsWith("refs/heads/proposals/") && !value.endsWith("/") && !value.endsWith(".")
  && !value.endsWith(".lock") && !value.includes("..") && !value.includes("@{") && !value.includes("\\")
  && !/[\x00-\x20\x7f~^:?*[\]]/.test(value)
  && value.slice("refs/heads/".length).split("/").every((part) => part.length > 0 && !part.startsWith(".")));
const pathRule = z.object({
  pathPrefix: z.string().min(1).max(1024).refine((value) => !value.startsWith("/") && !value.includes("\0")
    && !value.includes("//") && value.split("/").every((part) => part !== "." && part !== "..")),
  reviewerIds: z.array(identifier).min(1).readonly()
}).strict().readonly();

export const nativeImportedRootPolicySchema = z.object({
  schemaVersion: z.literal(1),
  protectedRef,
  policyRevision: revisionValue,
  requiredReviewRevision: revisionValue,
  requiredJobSetRevision: revisionValue,
  requiredJobs: z.array(z.object({
    name: jobName,
    kind: z.union([z.literal("ordinary-sysbox"), z.literal("qemu")]),
    evidenceClass: z.literal("candidate-controlled")
  }).strict().readonly()).min(1).max(64).readonly(),
  requiredReviewerIds: z.array(identifier).min(1).readonly(),
  pathReviewerRules: z.array(pathRule).readonly()
}).strict().readonly();

export type NativeImportedRootPolicy = z.infer<typeof nativeImportedRootPolicySchema>;
export type StoredImportedRootPolicy =
  | { readonly policyFormat: "authoritative-v1"; readonly policy: NativeImportedRootPolicy }
  | { readonly policyFormat: "legacy-import-only"; readonly policy: NativeGitReviewPolicy };

export function parseAuthoritativeImportedRootPolicy(value: unknown): NativeImportedRootPolicy {
  const result = nativeImportedRootPolicySchema.safeParse(value);
  if (!result.success) throw result.error;
  assertUnique(result.data.requiredJobs.map(({ name }) => name));
  assertUnique(result.data.requiredReviewerIds);
  for (const rule of result.data.pathReviewerRules) assertUnique(rule.reviewerIds);
  const normalized = {
    ...result.data,
    requiredJobs: [...result.data.requiredJobs].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    requiredReviewerIds: [...result.data.requiredReviewerIds].sort(),
    pathReviewerRules: normalizeRules(result.data.pathReviewerRules)
  };
  const reviewers = { requiredReviewerIds: normalized.requiredReviewerIds,
    pathReviewerRules: normalized.pathReviewerRules };
  if (normalized.requiredReviewRevision !== revision("reviewers", 1, reviewers)
    || normalized.requiredJobSetRevision !== revision("jobs", 2, normalized.requiredJobs)
    || normalized.policyRevision !== revision("policy", 2, {
      protectedRef: normalized.protectedRef, ...reviewers, requiredJobs: normalized.requiredJobs
    })) throw new ImportedRootPolicyError();
  return normalized;
}

export function parseLegacyImportedRootPolicy(value: unknown): NativeGitReviewPolicy {
  const result = nativeGitReviewPolicySchema.safeParse(value);
  if (!result.success) throw result.error;
  assertUnique(result.data.requiredJobNames);
  assertUnique(result.data.requiredReviewerIds);
  for (const rule of result.data.pathReviewerRules) assertUnique(rule.reviewerIds);
  return { ...result.data, requiredJobNames: [...result.data.requiredJobNames].sort(),
    requiredReviewerIds: [...result.data.requiredReviewerIds].sort(),
    pathReviewerRules: normalizeRules(result.data.pathReviewerRules) };
}

function normalizeRules(rules: readonly z.infer<typeof pathRule>[]): readonly z.infer<typeof pathRule>[] {
  return rules.map((rule) => ({ ...rule, reviewerIds: [...rule.reviewerIds].sort() }))
    .sort((left, right) => {
      const leftJson = JSON.stringify(left);
      const rightJson = JSON.stringify(right);
      return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
    });
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new ImportedRootPolicyError();
}

function revision(domain: "policy" | "reviewers" | "jobs", version: 1 | 2, value: unknown): string {
  return createHash("sha256").update(`dim-native-${domain}-v${version}\0`)
    .update(JSON.stringify(value)).digest("hex");
}

export class ImportedRootPolicyError extends Error {
  readonly name = "ImportedRootPolicyError";
}
