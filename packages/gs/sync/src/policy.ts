import { z } from "zod";
import type { PolicySectionOwner } from "@slop-lab/gs-repository-service";

export function validBranch(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.startsWith("-") && value !== "@"
    && !value.startsWith("refs/") && !value.startsWith("proposals/")
    && !/[\x00-\x20\x7f~^:?*[\\\]]/.test(value) && !value.includes("..") && !value.includes("@{")
    && value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
}

const branch = z.string().refine(validBranch, "expected a concrete branch name");
export const gitSyncPolicySchema = z.object({
  upstream: z.object({ url: z.string().url(), branch }).strict().readonly(),
  publish: z.record(branch, branch).default({}),
}).strict().readonly();
export type GitSyncPolicy = z.infer<typeof gitSyncPolicySchema>;

export function parseGitSyncPolicy(value: unknown, allowLocalRemotes: boolean): GitSyncPolicy {
  const policy = gitSyncPolicySchema.parse(value);
  const url = new URL(policy.upstream.url);
  if (url.username || url.password || url.search || url.hash || url.href !== policy.upstream.url
    || !(url.protocol === "https:" || (allowLocalRemotes && url.protocol === "file:" && url.hostname === ""))) {
    throw new GitSyncPolicyError("git-sync upstream requires a canonical credential-free HTTPS URL; local file URLs require explicit operator configuration");
  }
  return policy;
}

export function gitSyncPolicyOwner(allowLocalRemotes = false): PolicySectionOwner<GitSyncPolicy> {
  return {
    sectionName: "git-sync",
    enforcement: "configuration",
    parse: (value) => parseGitSyncPolicy(value, allowLocalRemotes),
  };
}

export class GitSyncPolicyError extends Error {
  readonly name = "GitSyncPolicyError";
}
