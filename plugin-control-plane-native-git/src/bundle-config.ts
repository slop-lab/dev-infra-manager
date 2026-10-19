import { Buffer } from "node:buffer";
import { z } from "zod";
import { externalWebhookSubscriberSchema } from "./external-webhook-config.js";
import { executionSourceCredentialsSchema } from "./execution-protocol.js";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const credentialUsername = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/);
const bundleToken = z.string().regex(/^[A-Za-z0-9_-]+$/).refine((value) => {
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= 32 && decoded.toString("base64url") === value;
});
const projectRegistrarToken = z.string().regex(/^[A-Za-z0-9_-]+$/).refine((value) => {
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
});
const credential = z.object({
  username: credentialUsername,
  password: bundleToken
}).strict().readonly();
const projectRegistrar = z.object({
  hostId: identifier,
  username: credentialUsername,
  password: projectRegistrarToken
}).strict().readonly();
const projectRootImporter = z.object({
  hostId: identifier,
  username: credentialUsername,
  password: projectRegistrarToken
}).strict().readonly();
const projectRootReadIssuer = z.object({
  hostId: identifier,
  username: credentialUsername,
  password: projectRegistrarToken
}).strict().readonly();
const workspaceWriteIssuer = z.object({
  hostId: identifier,
  username: credentialUsername,
  password: projectRegistrarToken
}).strict().readonly();
const humanReviewer = z.object({
  reviewerId: identifier,
  username: credentialUsername,
  password: projectRegistrarToken
}).strict().readonly();
const hostPromoter = z.object({
  hostId: identifier,
  username: credentialUsername,
  password: projectRegistrarToken
}).strict().readonly();

const nativeBundleConfigSchema = z.object({
  schemaVersion: z.literal(7),
  serviceId: z.literal("native-main"),
  host: z.string().min(1),
  port: z.number().int().min(0).max(65_535),
  storageRoot: z.string().startsWith("/"),
  gitExecutable: z.string().startsWith("/"),
  gitVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  projectRegistrars: z.array(projectRegistrar).readonly(),
  projectRootImporters: z.array(projectRootImporter).readonly(),
  projectRootReadIssuers: z.array(projectRootReadIssuer).readonly(),
  workspaceWriteIssuers: z.array(workspaceWriteIssuer).readonly(),
  humanReviewers: z.array(humanReviewer).readonly(),
  hostPromoters: z.array(hostPromoter).readonly(),
  webhooks: z.array(externalWebhookSubscriberSchema).max(32).readonly().optional(),
  ci: executionSourceCredentialsSchema.extend({
    webhook: z.object({ endpoint: z.literal("http://ordinary-ci:8080/v1/jobs"),
      username: credentialUsername, password: bundleToken }).strict().readonly()
  }).strict().readonly()
}).strict().readonly();

export type NativeGitBundleConfig = z.infer<typeof nativeBundleConfigSchema>;

export function parseNativeGitBundleConfig(input: unknown): NativeGitBundleConfig {
  const result = nativeBundleConfigSchema.safeParse(input);
  if (!result.success) throw new NativeGitBundleConfigError("invalid native Git bundle configuration");
  const config = result.data;
  if (new Set((config.webhooks ?? []).map(({ id }) => id)).size !== (config.webhooks ?? []).length) {
    throw new NativeGitBundleConfigError("external webhook subscriber ids must be distinct");
  }
  if (config.host !== "0.0.0.0" || config.port !== 8080) {
    throw new NativeGitBundleConfigError("native Git bundle listener must be 0.0.0.0:8080");
  }
  if (config.storageRoot !== "/var/lib/dim-native-git") {
    throw new NativeGitBundleConfigError("native Git bundle storage root must be /var/lib/dim-native-git");
  }
  assertDistinctCredentials(Object.values(config.ci), [
    ...config.projectRegistrars.flatMap((entry) => [entry.username, entry.password]),
    ...config.projectRootImporters.flatMap((entry) => [entry.username, entry.password]),
    ...config.projectRootReadIssuers.flatMap((entry) => [entry.username, entry.password]),
    ...config.workspaceWriteIssuers.flatMap((entry) => [entry.username, entry.password]),
    ...config.humanReviewers.flatMap((entry) => [entry.username, entry.password]),
    ...config.hostPromoters.flatMap((entry) => [entry.username, entry.password])
  ]);
  assertDistinctValues(config.projectRegistrars.map((entry) => entry.hostId));
  assertDistinctValues(config.projectRootImporters.map((entry) => entry.hostId));
  assertDistinctValues(config.projectRootReadIssuers.map((entry) => entry.hostId));
  assertDistinctValues(config.workspaceWriteIssuers.map((entry) => entry.hostId));
  assertDistinctValues(config.humanReviewers.map((entry) => entry.reviewerId));
  assertDistinctValues(config.hostPromoters.map((entry) => entry.hostId));
  const hostRoles = [...config.projectRegistrars, ...config.projectRootImporters, ...config.projectRootReadIssuers,
    ...config.workspaceWriteIssuers, ...config.hostPromoters];
  const scopeIds = [...hostRoles.map((entry) => entry.hostId), ...config.humanReviewers.map((entry) => entry.reviewerId)];
  const serviceRoles = Object.values(config.ci);
  if ([...serviceRoles.flatMap((entry) => [entry.username, entry.password]),
    ...hostRoles.map((entry) => entry.password), ...config.humanReviewers.map((entry) => entry.password)]
    .some((value) => scopeIds.includes(value))) {
    throw new NativeGitBundleConfigError("bundle credentials must be globally distinct");
  }
  return config;
}

export class NativeGitBundleConfigError extends Error {
  readonly name = "NativeGitBundleConfigError";
}

type Credential = { readonly username: string; readonly password: string };

function assertDistinctCredentials(credentials: readonly Credential[], tokens: readonly string[] = []): void {
  const values = [...credentials.flatMap((entry) => [entry.username, entry.password]), ...tokens];
  assertDistinctValues(values);
}

function assertDistinctValues(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new NativeGitBundleConfigError("bundle credentials must be globally distinct");
  }
}

