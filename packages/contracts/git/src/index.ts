import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const protectedRef = z.string().max(1024).refine((value) => value.startsWith("refs/heads/")
  && !value.startsWith("refs/heads/proposals/") && !value.endsWith("/") && !value.endsWith(".")
  && !value.endsWith(".lock") && !value.includes("..") && !value.includes("@{") && !value.includes("\\")
  && !/[\x00-\x20\x7f~^:?*[\]]/.test(value)
  && value.slice("refs/heads/".length).split("/").every((part) => part.length > 0 && !part.startsWith(".")));
export const nativeRepositoryBranchPolicySchema = z.object({ review: z.boolean() }).strict().readonly();
export type NativeRepositoryBranchPolicy = z.infer<typeof nativeRepositoryBranchPolicySchema>;
export const nativeImportedRootPolicySchema = z.object({
  schemaVersion: z.literal(1), protectedRef, policyRevision: z.string().regex(/^[0-9a-f]{64}$/),
  defaultRef: protectedRef.optional(),
  branches: z.record(protectedRef, nativeRepositoryBranchPolicySchema).optional(),
  extensions: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), z.unknown()).readonly()
}).strict().superRefine((policy, context) => {
  if ((policy.defaultRef === undefined) !== (policy.branches === undefined)) context.addIssue({ code: "custom", message: "defaultRef and branches must be declared together" });
  if (policy.branches !== undefined && (Object.keys(policy.branches).length > 64 || !Object.hasOwn(policy.branches, policy.protectedRef)
    || policy.defaultRef === undefined || !Object.hasOwn(policy.branches, policy.defaultRef))) context.addIssue({ code: "custom", message: "managed branches must include the import and default refs, with at most 64 entries" });
}).readonly();
export type NativeImportedRootPolicy = z.infer<typeof nativeImportedRootPolicySchema>;
export function nativeRepositoryPolicyRevision(input: Pick<NativeImportedRootPolicy, "protectedRef" | "extensions" | "defaultRef" | "branches">): string {
  return createHash("sha256").update("dim-repository-policy-v1\0").update(JSON.stringify(canonicalValue({ protectedRef: input.protectedRef, extensions: input.extensions,
    ...(input.defaultRef === undefined ? {} : { defaultRef: input.defaultRef }), ...(input.branches === undefined ? {} : { branches: input.branches }) }))).digest("hex");
}
export function nativeRepositoryDefaultRef(policy: NativeImportedRootPolicy): string { return policy.defaultRef ?? policy.protectedRef; }
export function nativeRepositoryBranches(policy: NativeImportedRootPolicy): Readonly<Record<string, NativeRepositoryBranchPolicy>> {
  return policy.branches ?? { [policy.protectedRef]: { review: true } };
}
export function nativeRepositoryBranchPolicy(policy: NativeImportedRootPolicy, ref: string): NativeRepositoryBranchPolicy {
  const branches = nativeRepositoryBranches(policy);
  if (!Object.hasOwn(branches, ref)) throw new Error("repository branch is not managed");
  return branches[ref]!;
}
export function parseAuthoritativeImportedRootPolicy(value: unknown): NativeImportedRootPolicy {
  const policy = nativeImportedRootPolicySchema.parse(value);
  if (policy.policyRevision !== nativeRepositoryPolicyRevision(policy)) throw new Error("repository policy revision is invalid");
  return policy;
}
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(Reflect.get(value, key))]));
}

const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const repositorySnapshotsSchema = z.record(identifier, z.object({ commit: gitObjectId, tree: gitObjectId }).strict().readonly()).refine((entries) => Object.keys(entries).length > 0 && Object.keys(entries).length <= 64).readonly();
export type RepositorySnapshots = z.infer<typeof repositorySnapshotsSchema>;
export type RepositorySelector = { readonly projectId: string; readonly repositoryId: string };
