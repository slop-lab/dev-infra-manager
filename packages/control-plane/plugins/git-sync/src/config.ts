import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const credential = z.object({ username: z.string().min(1).max(256).regex(/^[^:\x00-\x20\x7f]+$/),
  password: z.string().min(1).max(4096).regex(/^[^\x00-\x20\x7f]+$/) }).strict();
export const gitSyncConfigurationSchema = z.object({
  operators: z.array(credential.extend({ hostId: identifier, password: z.string().refine((value) =>
    Buffer.from(value, "base64url").length === 32 && Buffer.from(value, "base64url").toString("base64url") === value) }).strict().readonly()).readonly(),
  credential: credential.optional(),
  allowLocalRemotes: z.boolean().default(false)
}).strict().readonly();
export type GitSyncConfiguration = z.infer<typeof gitSyncConfigurationSchema>;

/** A concrete branch only, never a revision expression or refspec. */
export function validBranch(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.startsWith("-") && value !== "@"
    && !value.startsWith("refs/") && !value.startsWith("proposals/")
    && !/[\x00-\x20\x7f~^:?*[\\\]]/.test(value) && !value.includes("..") && !value.includes("@{")
    && value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
}
const branch = z.string().refine(validBranch, "expected a concrete branch name");
export const gitSyncPolicySchema = z.object({ upstream: z.object({ url: z.string().url(), branch }).strict().readonly(),
  publish: z.record(branch, branch).default({}) }).strict().readonly();
export type GitSyncPolicy = z.infer<typeof gitSyncPolicySchema>;
export function parseGitSyncPolicy(value: unknown, allowLocalRemotes: boolean): GitSyncPolicy {
  const policy = gitSyncPolicySchema.parse(value);
  const url = new URL(policy.upstream.url);
  if (url.username || url.password || url.search || url.hash || url.href !== policy.upstream.url
    || !(url.protocol === "https:" || (allowLocalRemotes && url.protocol === "file:" && url.hostname === ""))) {
    throw new Error("git-sync upstream requires a canonical credential-free HTTPS URL; local file URLs require explicit operator configuration");
  }
  return policy;
}
