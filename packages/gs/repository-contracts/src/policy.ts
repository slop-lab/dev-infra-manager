import { createHash } from "node:crypto";
import { z } from "zod";

const protectedRef = z.string().max(1024).refine((value) => value.startsWith("refs/heads/")
  && !value.startsWith("refs/heads/proposals/") && !value.endsWith("/") && !value.endsWith(".")
  && !value.endsWith(".lock") && !value.includes("..") && !value.includes("@{") && !value.includes("\\")
  && !/[\x00-\x20\x7f~^:?*[\]]/.test(value)
  && value.slice("refs/heads/".length).split("/").every((part) => part.length > 0 && !part.startsWith(".")));

export const repositoryBranchPolicySchema = z.record(z.string().min(1).max(64), z.json()).readonly();
export type RepositoryBranchPolicy = z.infer<typeof repositoryBranchPolicySchema>;

const repositoryPolicyShape = z.object({
  schemaVersion: z.literal(1),
  protectedRef,
  policyRevision: z.string().regex(/^[0-9a-f]{64}$/),
  defaultRef: protectedRef.optional(),
  branches: z.record(protectedRef, repositoryBranchPolicySchema).optional(),
  extensions: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), z.unknown()).readonly()
}).strict();

export const repositoryPolicySchema = repositoryPolicyShape.superRefine((policy, context) => {
  if ((policy.defaultRef === undefined) !== (policy.branches === undefined)) {
    context.addIssue({ code: "custom", message: "defaultRef and branches must be declared together" });
  }
  if (policy.branches !== undefined && (Object.keys(policy.branches).length > 64
    || !Object.hasOwn(policy.branches, policy.protectedRef)
    || policy.defaultRef === undefined || !Object.hasOwn(policy.branches, policy.defaultRef))) {
    context.addIssue({ code: "custom", message: "managed branches must include the import and default refs, with at most 64 entries" });
  }
}).readonly();

export type RepositoryPolicy = z.infer<typeof repositoryPolicySchema>;

export function repositoryPolicyRevision(
  input: Pick<RepositoryPolicy, "protectedRef" | "extensions" | "defaultRef" | "branches">
): string {
  return createHash("sha256").update("dim-repository-policy-v1\0").update(JSON.stringify(canonicalValue({
    protectedRef: input.protectedRef,
    extensions: input.extensions,
    ...(input.defaultRef === undefined ? {} : { defaultRef: input.defaultRef }),
    ...(input.branches === undefined ? {} : { branches: input.branches })
  }))).digest("hex");
}

export function repositoryDefaultRef(policy: RepositoryPolicy): string {
  return policy.defaultRef ?? policy.protectedRef;
}

export function repositoryBranches(policy: RepositoryPolicy): Readonly<Record<string, RepositoryBranchPolicy>> {
  return policy.branches ?? { [policy.protectedRef]: {} };
}

export function repositoryBranchPolicy(policy: RepositoryPolicy, ref: string): RepositoryBranchPolicy {
  const branches = repositoryBranches(policy);
  const branch = branches[ref];
  if (!Object.hasOwn(branches, ref) || branch === undefined) throw new RepositoryPolicyError("repository branch is not managed");
  return branch;
}

export function parseRepositoryPolicy(value: unknown): RepositoryPolicy {
  const policy = repositoryPolicySchema.parse(value);
  if (policy.policyRevision !== repositoryPolicyRevision(policy)) {
    throw new RepositoryPolicyError("repository policy revision is invalid");
  }
  return policy;
}

export class RepositoryPolicyError extends Error {
  readonly name = "RepositoryPolicyError";
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(Reflect.get(value, key))]));
}
