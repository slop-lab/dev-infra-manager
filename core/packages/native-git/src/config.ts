import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const username = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/);
const password = z.string().min(16).max(1024).refine((value) => !/[\0\r\n]/.test(value));
const revision = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/);
const protectedRef = z.string().max(1024).refine((value) => safeHeadRef(value) && !value.startsWith("refs/heads/proposals/"));
const pathPrefix = z.string().min(1).max(1024).refine((value) => {
  if (value.startsWith("/") || value.includes("\0") || value.includes("//")) return false;
  return value.split("/").every((component) => component !== "." && component !== "..");
});

export const nativeGitReviewPolicySchema = z.object({
  protectedRef,
  policyRevision: revision,
  requiredReviewRevision: revision,
  requiredJobSetRevision: revision,
  requiredJobNames: z.array(identifier).min(1).readonly(),
  requiredReviewerIds: z.array(identifier).min(1).readonly(),
  pathReviewerRules: z.array(z.object({
    pathPrefix,
    reviewerIds: z.array(identifier).min(1).readonly()
  }).strict().readonly()).readonly().default([])
}).strict().readonly();

export const nativeGitRepositorySchema = z.object({
  projectId: identifier,
  repositoryId: identifier,
  reviewPolicies: z.array(nativeGitReviewPolicySchema).readonly().optional()
}).strict().readonly();

const identityBase = {
  username,
  password,
  projectId: identifier,
  repositoryIds: z.array(identifier).min(1)
} as const;

export const nativeGitIdentitySchema = z.discriminatedUnion("role", [
  z.object({ ...identityBase, role: z.literal("reader") }).strict().readonly(),
  z.object({ ...identityBase, role: z.literal("writer"), workspaceId: identifier }).strict().readonly(),
  z.object({ ...identityBase, role: z.literal("reviewer"), reviewerId: identifier }).strict().readonly(),
  z.object({ ...identityBase, role: z.literal("ci"), jobName: identifier }).strict().readonly(),
  z.object({ ...identityBase, role: z.literal("scheduler") }).strict().readonly(),
  z.object({ ...identityBase, role: z.literal("promoter") }).strict().readonly(),
  z.object({ ...identityBase, role: z.literal("administrator") }).strict().readonly()
]);

const ordinaryServiceCredentialSchema = z.object({ username, password }).strict().readonly();

export const ordinaryCiDependencyConfigSchema = z.object({
  endpoint: z.literal("http://ordinary-ci:8080"),
  serviceId: z.literal("ordinary-main"),
  query: ordinaryServiceCredentialSchema,
  identity: ordinaryServiceCredentialSchema,
  attemptIssuer: ordinaryServiceCredentialSchema,
  resultReporter: ordinaryServiceCredentialSchema
}).strict().readonly();

export const nativeGitServiceConfigSchema = z.object({
  schemaVersion: z.literal(1),
  host: z.string().min(1),
  port: z.number().int().min(0).max(65_535),
  storageRoot: z.string().startsWith("/"),
  gitExecutable: z.string().startsWith("/"),
  gitVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  repositories: z.array(nativeGitRepositorySchema).min(1).readonly(),
  identities: z.array(nativeGitIdentitySchema).min(1).readonly(),
  ordinaryCi: ordinaryCiDependencyConfigSchema.optional()
}).strict().readonly();

export type NativeGitRepository = z.infer<typeof nativeGitRepositorySchema>;
export type NativeGitIdentity = z.infer<typeof nativeGitIdentitySchema>;
export type NativeGitServiceConfig = z.infer<typeof nativeGitServiceConfigSchema>;
export type NativeGitReviewPolicy = z.infer<typeof nativeGitReviewPolicySchema>;
export type OrdinaryCiDependencyConfig = z.infer<typeof ordinaryCiDependencyConfigSchema>;

export function parseNativeGitServiceConfig(input: unknown): NativeGitServiceConfig {
  const config = nativeGitServiceConfigSchema.parse(input);
  const repositories = new Set<string>();
  for (const repository of config.repositories) {
    const key = repositoryKey(repository.projectId, repository.repositoryId);
    if (repositories.has(key)) throw new NativeGitConfigError(`duplicate repository registration: ${key}`);
    repositories.add(key);
  }
  const usernames = new Set<string>();
  const workspaces = new Set<string>();
  const reviewers = new Map<string, NativeGitIdentity & { readonly role: "reviewer" }>();
  const ciReporters = new Map<string, NativeGitIdentity & { readonly role: "ci" }>();
  const schedulers = new Set<string>();
  for (const identity of config.identities) {
    if (usernames.has(identity.username)) throw new NativeGitConfigError(`duplicate identity: ${identity.username}`);
    usernames.add(identity.username);
    for (const repositoryId of identity.repositoryIds) {
      if (!repositories.has(repositoryKey(identity.projectId, repositoryId))) {
        throw new NativeGitConfigError(`identity ${identity.username} references an unregistered repository`);
      }
    }
    if (identity.role === "writer") {
      const key = `${identity.projectId}/${identity.workspaceId}`;
      if (workspaces.has(key)) throw new NativeGitConfigError(`duplicate workspace writer: ${key}`);
      workspaces.add(key);
    }
    if (identity.role === "reviewer") {
      if (reviewers.has(identity.reviewerId)) throw new NativeGitConfigError(`duplicate reviewer ID: ${identity.reviewerId}`);
      reviewers.set(identity.reviewerId, identity);
    }
    if (identity.role === "ci") {
      for (const repositoryId of identity.repositoryIds) {
        const key = `${identity.projectId}/${repositoryId}/${identity.jobName}`;
        if (ciReporters.has(key)) throw new NativeGitConfigError(`duplicate CI job identity: ${key}`);
        ciReporters.set(key, identity);
      }
    }
    if (identity.role === "scheduler") {
      for (const repositoryId of identity.repositoryIds) schedulers.add(repositoryKey(identity.projectId, repositoryId));
    }
  }
  if (config.ordinaryCi !== undefined) {
    const serviceCredentials = [
      config.ordinaryCi.query,
      config.ordinaryCi.identity,
      config.ordinaryCi.attemptIssuer,
      config.ordinaryCi.resultReporter
    ];
    const serviceUsernames = new Set(serviceCredentials.map((credential) => credential.username));
    const servicePasswords = new Set(serviceCredentials.map((credential) => credential.password));
    if (serviceUsernames.size !== serviceCredentials.length || servicePasswords.size !== serviceCredentials.length) {
      throw new NativeGitConfigError("ordinary CI service credentials must be distinct");
    }
    for (const credential of serviceCredentials) {
      if (usernames.has(credential.username)
        || config.identities.some((identity) => identity.password === credential.password)) {
        throw new NativeGitConfigError("ordinary CI and native Git credentials must be distinct");
      }
    }
  }
  for (const repository of config.repositories) {
    const refs = new Set<string>();
    for (const policy of repository.reviewPolicies ?? []) {
      if (refs.has(policy.protectedRef)) throw new NativeGitConfigError(`duplicate review policy: ${policy.protectedRef}`);
      refs.add(policy.protectedRef);
      const reviewerIds = [
        ...policy.requiredReviewerIds,
        ...policy.pathReviewerRules.flatMap((rule) => rule.reviewerIds)
      ];
      if (new Set(policy.requiredReviewerIds).size !== policy.requiredReviewerIds.length) {
        throw new NativeGitConfigError(`review policy contains duplicate required reviewers: ${policy.protectedRef}`);
      }
      if (new Set(policy.requiredJobNames).size !== policy.requiredJobNames.length) {
        throw new NativeGitConfigError(`review policy contains duplicate required jobs: ${policy.protectedRef}`);
      }
      for (const reviewerId of reviewerIds) {
        const reviewer = reviewers.get(reviewerId);
        if (reviewer === undefined || reviewer.projectId !== repository.projectId
          || !reviewer.repositoryIds.includes(repository.repositoryId)) {
          throw new NativeGitConfigError(`review policy references unavailable reviewer: ${reviewerId}`);
        }
      }
      for (const jobName of policy.requiredJobNames) {
        if (!ciReporters.has(`${repository.projectId}/${repository.repositoryId}/${jobName}`)) {
          throw new NativeGitConfigError(`review policy references unavailable CI job: ${jobName}`);
        }
      }
      if (!schedulers.has(repositoryKey(repository.projectId, repository.repositoryId))) {
        throw new NativeGitConfigError(`review policy requires an unavailable scheduler: ${policy.protectedRef}`);
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

function safeHeadRef(value: string): boolean {
  if (!value.startsWith("refs/heads/") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("\\") || /[\x00-\x20\x7f~^:?*[\]]/.test(value)) return false;
  return value.slice("refs/heads/".length).split("/").every((component) => component.length > 0 && !component.startsWith("."));
}
