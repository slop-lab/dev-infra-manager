import { createHash } from "node:crypto";
import { z } from "zod";
import type { RepositoryPolicy } from "@slop-lab/gs-repository-contracts";
import type { PolicySectionOwner } from "@slop-lab/gs-repository-service";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
export const gitCiPolicySchema = z.object({
  ciRepositoryIds: z.array(identifier).min(1).max(64),
  requiredJobs: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    provider: identifier, evidenceClass: z.literal("candidate-controlled") }).strict()).max(64)
}).strict().readonly();
const persistedGitCiPolicySchema = z.object({
  ciRepositoryIds: z.array(identifier).min(1).max(64),
  requiredJobs: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    kind: identifier, evidenceClass: z.literal("candidate-controlled") }).strict()).max(64),
}).strict().readonly();
export type GitCiPolicy = z.infer<typeof gitCiPolicySchema> & { readonly requiredJobSetRevision: string };
export function gitCiPolicy(policy: RepositoryPolicy, repositoryId: string): GitCiPolicy {
  const value = policy.extensions["git-ci"];
  return parseGitCiPolicy(value === undefined ? { ciRepositoryIds: [repositoryId], requiredJobs: [] } : value, repositoryId);
}
export function parseGitCiPolicy(value: unknown, repositoryId?: string): GitCiPolicy {
  const primary = gitCiPolicySchema.safeParse(value);
  const parsed = primary.success ? primary.data : persistedPolicy(value);
  if (repositoryId !== undefined && !parsed.ciRepositoryIds.includes(repositoryId) || new Set(parsed.ciRepositoryIds).size !== parsed.ciRepositoryIds.length
    || new Set(parsed.requiredJobs.map(({ name }) => name)).size !== parsed.requiredJobs.length) throw new Error("invalid Git CI repository or job allowlist");
  const normalized = { ciRepositoryIds: [...parsed.ciRepositoryIds].sort(), requiredJobs: [...parsed.requiredJobs].sort((left, right) => left.name.localeCompare(right.name)),
    requiredJobSetRevision: requiredJobsRevision([...parsed.requiredJobs].sort((left, right) => left.name.localeCompare(right.name))) };
  return normalized;
}
export function requiredJobsRevision(jobs: readonly { readonly name: string; readonly provider: string; readonly evidenceClass: string }[]): string {
  return createHash("sha256").update("dim-native-jobs-v2\0").update(JSON.stringify(jobs.map(({ name, provider, evidenceClass }) => ({
    name, kind: provider, evidenceClass,
  })))).digest("hex");
}

function persistedPolicy(value: unknown): z.infer<typeof gitCiPolicySchema> {
  const parsed = persistedGitCiPolicySchema.parse(value);
  return gitCiPolicySchema.parse({
    ciRepositoryIds: parsed.ciRepositoryIds,
    requiredJobs: parsed.requiredJobs.map(({ name, kind, evidenceClass }) => ({ name, provider: kind, evidenceClass })),
  });
}

export const gitCiPolicyOwner: PolicySectionOwner<GitCiPolicy> = {
  sectionName: "git-ci",
  enforcement: "authorization",
  parse: (value) => parseGitCiPolicy(value),
};
