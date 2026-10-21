import { z } from "zod";
import type { Operation } from "@slop-lab/dim-contracts-operations";
import { nativeGitProjectSchema } from "./operator.js";
const id = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const publicUrl = z.string().min(1).max(2048).refine((value) => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname !== "/" && url.hostname !== "localhost" && !url.hostname.endsWith(".localhost"); } catch { return false; }
}, "a public HTTPS repository URL without credentials, query or fragment is required");
const branch = z.string().min(1).max(255).refine((value) => !value.startsWith("-") && !value.startsWith("/") && !value.startsWith("refs/") && !value.endsWith("/") && !value.endsWith(".") && !value.endsWith(".lock") && !/[\s\x00-\x1f\x7f-\uffff~^:?*\[\\]/.test(value) && !value.includes("..") && !value.includes("@{") && !value.includes("//") && value !== "@");
export const nativeGitRepositoryImportResultSchema = z.object({ projectId: id, repositoryId: id, protectedRef: z.string().startsWith("refs/heads/").max(1024), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), projectReady: z.boolean() }).strict();
const manifestInput = z.object({ projectId: id, manifest: z.string().min(1).max(64 * 1024)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 64 * 1024, "manifest exceeds its 64 KiB UTF-8 bound") }).strict()
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 96 * 1024 - 1024, "encoded manifest exceeds its controller transport bound");
export const nativeGitManifestPreviewSchema = z.object({ projectId: id, repositories: z.array(z.object({ repositoryId: id, url: publicUrl, branch, protectedRef: z.string().startsWith("refs/heads/"), policy: z.record(z.string(), z.unknown()) }).strict()).min(1).max(16), configurationRepositoryId: id, defaultWorkingRepositoryId: id }).strict();
/** Host-owned management. A direct reviewer connection never receives these operations. */
export const nativeGitManagementOperations: readonly Operation[] = [
  { name: "projects.create", description: "Create a controller project", access: "operator", parseInput: (value) => z.object({ projectId: id.max(48) }).strict().parse(value), parseOutput: (value) => nativeGitProjectSchema.parse(value) },
  { name: "repositories.import", description: "Import a public HTTPS Git repository with controller review policy", access: "operator", parseInput: (value) => z.object({ projectId: id, repositoryId: id, url: publicUrl, branch: branch.optional() }).strict().parse(value), parseOutput: (value) => nativeGitRepositoryImportResultSchema.parse(value) },
  { name: "repositories.preview-manifest", description: "Review repository sources and policy from .dim/repos.yml before importing", access: "operator", parseInput: (value) => manifestInput.parse(value), parseOutput: (value) => nativeGitManifestPreviewSchema.parse(value) },
  { name: "repositories.import-manifest", description: "Import repositories and explicitly approved policy from .dim/repos.yml", access: "operator", parseInput: (value) => manifestInput.parse(value), parseOutput: (value) => z.object({ projectId: id, repositories: z.array(nativeGitRepositoryImportResultSchema).min(1).max(16) }).strict().parse(value) }
];
