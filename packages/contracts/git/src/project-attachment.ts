import { createHash } from "node:crypto";
import { z } from "zod";
import { nativeImportedRootPolicySchema } from "./policy.js";

export const nativeGitProjectCatalogMaximumProjects = 1_024;
export const nativeGitProjectAttachmentMaximumRepositories = 64;
export const nativeGitProjectAttachmentMaximumBytes = 512 * 1_024;

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const hostIdentifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const protectedRef = z.string().max(1_024).startsWith("refs/heads/");

export const nativeGitRootImportReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.literal("native-main"),
  projectId: identifier,
  repositoryId: identifier,
  generationId: digest,
  importNonce: z.string().uuid(),
  protectedRef,
  expectedCommit: objectId,
  policyDigest: digest,
  bundleDigest: digest,
  bundleSize: z.number().int().positive().max(256 * 1_024 * 1_024),
  resolvedTree: objectId,
  phase: z.literal("repository-imported")
}).strict().readonly();

export const nativeGitProjectCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.literal("native-main"),
  generationId: digest,
  ownerHostId: hostIdentifier,
  projects: z.array(z.object({
    projectId: identifier,
    repositoryCount: z.number().int().positive().max(nativeGitProjectAttachmentMaximumRepositories)
  }).strict().readonly()).max(nativeGitProjectCatalogMaximumProjects).readonly()
}).strict().superRefine((catalog, context) => {
  const projectIds = catalog.projects.map((project) => project.projectId);
  if (new Set(projectIds).size !== projectIds.length
    || projectIds.join("\0") !== [...projectIds].sort().join("\0")) {
    context.addIssue({ code: "custom", message: "native Git Project catalog entries must be unique and ordered" });
  }
}).readonly();

const currentHead = z.object({
  projectId: identifier,
  repositoryId: identifier,
  sequence: z.number().int().nonnegative(),
  protectedRef,
  commit: objectId,
  tree: objectId,
  policyDigest: digest
}).strict().readonly();

export const nativeGitProjectAttachmentSchema = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.literal("native-main"),
  generationId: digest,
  ownerHostId: hostIdentifier,
  projectId: identifier,
  repositories: z.array(z.object({
    repositoryId: identifier,
    importReceipt: nativeGitRootImportReceiptSchema,
    importedPolicy: nativeImportedRootPolicySchema,
    effectivePolicy: nativeImportedRootPolicySchema,
    currentHead
  }).strict().readonly()).min(1).max(nativeGitProjectAttachmentMaximumRepositories).readonly()
}).strict().superRefine((attachment, context) => {
  const repositoryIds = attachment.repositories.map((repository) => repository.repositoryId);
  if (new Set(repositoryIds).size !== repositoryIds.length
    || repositoryIds.join("\0") !== [...repositoryIds].sort().join("\0")) {
    context.addIssue({ code: "custom", message: "native Git Project attachment repositories must be unique and ordered" });
  }
  for (const repository of attachment.repositories) {
    const receipt = repository.importReceipt;
    const head = repository.currentHead;
    if (receipt.projectId !== attachment.projectId || head.projectId !== attachment.projectId
      || receipt.repositoryId !== repository.repositoryId || head.repositoryId !== repository.repositoryId) {
      context.addIssue({ code: "custom", message: "native Git Project attachment repository scope is inconsistent" });
    }
    if (receipt.protectedRef !== repository.importedPolicy.protectedRef
      || receipt.protectedRef !== repository.effectivePolicy.protectedRef
      || receipt.protectedRef !== head.protectedRef) {
      context.addIssue({ code: "custom", message: "native Git Project attachment protected ref is inconsistent" });
    }
    const importedDigest = createHash("sha256").update(JSON.stringify(repository.importedPolicy), "utf8").digest("hex");
    const effectiveDigest = createHash("sha256").update(JSON.stringify(repository.effectivePolicy), "utf8").digest("hex");
    if (receipt.policyDigest !== importedDigest || head.policyDigest !== effectiveDigest) {
      context.addIssue({ code: "custom", message: "native Git Project attachment policy digest is inconsistent" });
    }
  }
}).readonly();

export type NativeGitRootImportReceipt = z.infer<typeof nativeGitRootImportReceiptSchema>;
export type NativeGitProjectCatalog = z.infer<typeof nativeGitProjectCatalogSchema>;
export type NativeGitProjectAttachment = z.infer<typeof nativeGitProjectAttachmentSchema>;

export function parseNativeGitProjectCatalog(value: unknown): NativeGitProjectCatalog {
  return parseBoundedResponse(nativeGitProjectCatalogSchema, value);
}

export function parseNativeGitProjectAttachment(value: unknown): NativeGitProjectAttachment {
  return parseBoundedResponse(nativeGitProjectAttachmentSchema, value);
}

function parseBoundedResponse<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > nativeGitProjectAttachmentMaximumBytes) {
    throw new NativeGitProjectAttachmentContractError("native Git Project attachment response exceeds limit");
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new NativeGitProjectAttachmentContractError("native Git Project attachment response is invalid", {
      cause: result.error
    });
  }
  return result.data;
}

export class NativeGitProjectAttachmentContractError extends Error {
  readonly name = "NativeGitProjectAttachmentContractError";
}
