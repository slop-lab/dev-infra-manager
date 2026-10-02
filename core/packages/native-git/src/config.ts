import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const username = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/);
const password = z.string().min(16).max(1024).refine((value) => !/[\0\r\n]/.test(value));

export const nativeGitRepositorySchema = z.object({
  projectId: identifier,
  repositoryId: identifier
}).strict().readonly();

const identityBase = {
  username,
  password,
  projectId: identifier,
  repositoryIds: z.array(identifier).min(1)
} as const;

export const nativeGitIdentitySchema = z.discriminatedUnion("role", [
  z.object({ ...identityBase, role: z.literal("reader") }).strict().readonly(),
  z.object({ ...identityBase, role: z.literal("writer"), workspaceId: identifier }).strict().readonly()
]);

export const nativeGitServiceConfigSchema = z.object({
  schemaVersion: z.literal(1),
  host: z.string().min(1),
  port: z.number().int().min(0).max(65_535),
  storageRoot: z.string().startsWith("/"),
  gitExecutable: z.string().startsWith("/"),
  gitVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  repositories: z.array(nativeGitRepositorySchema).min(1).readonly(),
  identities: z.array(nativeGitIdentitySchema).min(1).readonly()
}).strict().readonly();

export type NativeGitRepository = z.infer<typeof nativeGitRepositorySchema>;
export type NativeGitIdentity = z.infer<typeof nativeGitIdentitySchema>;
export type NativeGitServiceConfig = z.infer<typeof nativeGitServiceConfigSchema>;

export function parseNativeGitServiceConfig(input: unknown): NativeGitServiceConfig {
  const config = nativeGitServiceConfigSchema.parse(input);
  const repositories = new Set<string>();
  for (const repository of config.repositories) {
    const key = repositoryKey(repository.projectId, repository.repositoryId);
    if (repositories.has(key)) throw new NativeGitConfigError(`duplicate repository registration: ${key}`);
    repositories.add(key);
  }
  const usernames = new Set<string>();
  for (const identity of config.identities) {
    if (usernames.has(identity.username)) throw new NativeGitConfigError(`duplicate identity: ${identity.username}`);
    usernames.add(identity.username);
    for (const repositoryId of identity.repositoryIds) {
      if (!repositories.has(repositoryKey(identity.projectId, repositoryId))) {
        throw new NativeGitConfigError(`identity ${identity.username} references an unregistered repository`);
      }
    }
  }
  return config;
}

export function repositoryKey(projectId: string, repositoryId: string): string {
  return `${projectId}/${repositoryId}`;
}

export class NativeGitConfigError extends Error {
  readonly name = "NativeGitConfigError";
}
