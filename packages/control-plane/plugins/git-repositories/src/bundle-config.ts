import { Buffer } from "node:buffer";
import { z } from "zod";

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
}).strict().readonly();

export type NativeGitBundleConfig = z.infer<typeof nativeBundleConfigSchema>;

export function parseNativeGitBundleConfig(input: unknown): NativeGitBundleConfig {
  const result = nativeBundleConfigSchema.safeParse(input);
  if (!result.success) throw new NativeGitBundleConfigError("invalid native Git bundle configuration");
  const config = result.data;
  if (config.host !== "0.0.0.0" || config.port !== 8080) {
    throw new NativeGitBundleConfigError("native Git bundle listener must be 0.0.0.0:8080");
  }
  if (config.storageRoot !== "/var/lib/dim-native-git") {
    throw new NativeGitBundleConfigError("native Git bundle storage root must be /var/lib/dim-native-git");
  }
  const roles = [...config.projectRegistrars, ...config.projectRootImporters, ...config.projectRootReadIssuers, ...config.workspaceWriteIssuers];
  assertDistinctValues(roles.flatMap((entry) => [entry.username, entry.password]));
  for (const entries of [config.projectRegistrars, config.projectRootImporters, config.projectRootReadIssuers, config.workspaceWriteIssuers]) assertDistinctValues(entries.map((entry) => entry.hostId));
  return config;
}

export class NativeGitBundleConfigError extends Error {
  readonly name = "NativeGitBundleConfigError";
}

function assertDistinctValues(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new NativeGitBundleConfigError("bundle credentials must be globally distinct");
  }
}
