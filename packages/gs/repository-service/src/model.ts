import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { repositoryPolicySchema, type RepositoryPolicy } from "@slop-lab/gs-repository-contracts";

export const identifierSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
export const objectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const principalIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const protectedRefSchema = z.string().startsWith("refs/heads/");
export const selectorSchema = z.object({ namespaceId: identifierSchema, repositoryId: identifierSchema }).strict().readonly();

export const branchRegistrationSchema = z.object({
  protectedRef: protectedRefSchema,
  commit: objectIdSchema,
  tree: objectIdSchema,
}).strict().readonly();

export const registerRepositorySchema = z.object({
  selector: selectorSchema,
  ownerPrincipalId: principalIdSchema,
  policy: repositoryPolicySchema,
  branches: z.array(branchRegistrationSchema).min(1).max(64).readonly(),
}).strict().readonly();

export const replacePolicySchema = z.object({
  selector: selectorSchema,
  expectedPolicyDigest: digestSchema,
  expectedProtectedHead: objectIdSchema,
  policy: repositoryPolicySchema,
}).strict().readonly();

export type RegisterRepositoryInput = z.infer<typeof registerRepositorySchema>;
export type ReplaceRepositoryPolicyInput = z.infer<typeof replacePolicySchema>;
export type BranchRegistration = z.infer<typeof branchRegistrationSchema>;

export function repositoryPolicyDigest(policy: RepositoryPolicy): string {
  return createHash("sha256").update(JSON.stringify(repositoryPolicySchema.parse(policy))).digest("hex");
}

export function immutableRepositoryPolicy(policy: RepositoryPolicy): RepositoryPolicy {
  const serialized = JSON.stringify(repositoryPolicySchema.parse(policy));
  const value: unknown = JSON.parse(serialized);
  const copy = repositoryPolicySchema.parse(value);
  freezeValue(copy);
  return copy;
}

export function repositoryKey(selector: { readonly namespaceId: string; readonly repositoryId: string }): string {
  return `${selector.namespaceId}/${selector.repositoryId}`;
}

export function newAuthorityEpoch(): string {
  return randomBytes(32).toString("hex");
}

function freezeValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) freezeValue(entry);
    Object.freeze(value);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) freezeValue(entry);
    Object.freeze(value);
  }
}
