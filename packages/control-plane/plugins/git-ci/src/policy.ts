import { createHash } from "node:crypto";
import { z } from "zod";
import type { NativeImportedRootPolicy } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
export const gitCiPolicySchema = z.object({
  ciRepositoryIds: z.array(identifier).min(1).max(64),
  requiredJobs: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    kind: z.enum(["ordinary-sysbox", "qemu"]), evidenceClass: z.literal("candidate-controlled") }).strict()).max(64)
}).strict().readonly();
export type GitCiPolicy = z.infer<typeof gitCiPolicySchema> & { readonly requiredJobSetRevision: string };
export function gitCiPolicy(policy: NativeImportedRootPolicy, repositoryId: string): GitCiPolicy {
  const value = policy.extensions["git-ci"];
  return parseGitCiPolicy(value === undefined ? { ciRepositoryIds: [repositoryId], requiredJobs: [] } : value, repositoryId);
}
export function parseGitCiPolicy(value: unknown, repositoryId?: string): GitCiPolicy {
  const parsed = gitCiPolicySchema.parse(value);
  if (repositoryId !== undefined && !parsed.ciRepositoryIds.includes(repositoryId) || new Set(parsed.ciRepositoryIds).size !== parsed.ciRepositoryIds.length
    || new Set(parsed.requiredJobs.map(({ name }) => name)).size !== parsed.requiredJobs.length) throw new Error("invalid Git CI repository or job allowlist");
  const normalized = { ciRepositoryIds: [...parsed.ciRepositoryIds].sort(), requiredJobs: [...parsed.requiredJobs].sort((left, right) => left.name.localeCompare(right.name)),
    requiredJobSetRevision: requiredJobsRevision([...parsed.requiredJobs].sort((left, right) => left.name.localeCompare(right.name))) };
  return normalized;
}
export function requiredJobsRevision(jobs: readonly { readonly name: string; readonly kind: string; readonly evidenceClass: string }[]): string {
  return createHash("sha256").update("dim-native-jobs-v2\0").update(JSON.stringify(jobs)).digest("hex");
}
