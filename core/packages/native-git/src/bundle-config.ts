import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  nativeGitIdentitySchema,
  nativeGitRepositorySchema,
  nativeGitServiceConfigSchema,
  ordinaryCiDependencyConfigSchema
} from "./config.js";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const credentialUsername = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/);
const bundleToken = z.string().regex(/^[A-Za-z0-9_-]+$/).refine((value) => {
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= 32 && decoded.toString("base64url") === value;
});
const credential = z.object({
  username: credentialUsername,
  password: bundleToken
}).strict().readonly();
const positiveDecimal = z.string().regex(/^[1-9][0-9]*$/);
const bounds = z.object({
  cpu: positiveDecimal,
  memoryBytes: positiveDecimal,
  pids: positiveDecimal,
  wallClockSeconds: positiveDecimal,
  outputBytes: positiveDecimal
}).strict().readonly();
const capacity = z.object({
  capacity: identifier,
  runnerBaseImage: z.string().regex(/^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/),
  bounds
}).strict().readonly();
const host = z.object({
  hostId: identifier,
  hostToken: bundleToken,
  capacities: z.array(capacity).min(1).readonly()
}).strict().readonly();

const nativeBundleConfigSchema = nativeGitServiceConfigSchema.unwrap().extend({
  repositories: z.array(nativeGitRepositorySchema).readonly(),
  identities: z.array(nativeGitIdentitySchema).readonly(),
  ordinaryCi: ordinaryCiDependencyConfigSchema.unwrap().extend({
    query: credential,
    identity: credential,
    attemptIssuer: credential,
    resultReporter: credential,
    webhook: z.object({
      endpoint: z.literal("http://ordinary-ci:8080/v1/native-events"),
      username: credentialUsername,
      password: bundleToken
    }).strict().readonly()
  }).strict().readonly()
}).strict().readonly();

const ordinaryBundleConfigSchema = z.object({
  schemaVersion: z.literal(3),
  serviceId: z.literal("ordinary-main"),
  database: z.literal("/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3"),
  admissionLeaseMilliseconds: z.number().int().positive(),
  claimLeaseMilliseconds: z.number().int().positive(),
  nativeGit: z.object({
    endpoint: z.literal("http://native-git:8080"),
    serviceId: z.literal("native-main"),
    identity: credential,
    attemptIssuer: credential,
    resultReporter: credential
  }).strict().readonly(),
  credentials: z.object({
    webhook: credential,
    registrar: credential,
    query: credential
  }).strict().readonly(),
  hosts: z.array(host).min(1).readonly()
}).strict().readonly();

export type NativeGitBundleConfig = z.infer<typeof nativeBundleConfigSchema>;
export type OrdinaryBundleConfig = z.infer<typeof ordinaryBundleConfigSchema>;

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
  if (config.repositories.length !== 0) {
    throw new NativeGitBundleConfigError("native Git bundle repository registry must be empty");
  }
  if (config.identities.length !== 0) {
    throw new NativeGitBundleConfigError("native Git bundle identity registry must be empty");
  }
  assertDistinctCredentials([
    config.ordinaryCi.query,
    config.ordinaryCi.identity,
    config.ordinaryCi.attemptIssuer,
    config.ordinaryCi.resultReporter,
    config.ordinaryCi.webhook
  ]);
  return config;
}

export function parseOrdinaryBundleConfig(input: unknown): OrdinaryBundleConfig {
  const result = ordinaryBundleConfigSchema.safeParse(input);
  if (!result.success) {
    const hosts = typeof input === "object" && input !== null ? Reflect.get(input, "hosts") : undefined;
    if (Array.isArray(hosts) && hosts.length === 0) {
      throw new NativeGitBundleConfigError("ordinary CI bundle requires at least one host");
    }
    if (result.error.issues.some((issue) => issue.path.at(-1) === "hostToken")) {
      throw new NativeGitBundleConfigError("ordinary CI bundle host token is invalid");
    }
    throw new NativeGitBundleConfigError("invalid ordinary CI bundle configuration");
  }
  const config = result.data;
  const hostIds = new Set<string>();
  const hostTokens = new Set<string>();
  for (const configuredHost of config.hosts) {
    if (hostIds.has(configuredHost.hostId)) {
      throw new NativeGitBundleConfigError("ordinary CI bundle host IDs must be unique");
    }
    hostIds.add(configuredHost.hostId);
    if (hostTokens.has(configuredHost.hostToken)) {
      throw new NativeGitBundleConfigError("ordinary CI bundle host tokens must be unique");
    }
    hostTokens.add(configuredHost.hostToken);
    if (new Set(configuredHost.capacities.map((entry) => entry.capacity)).size !== configuredHost.capacities.length) {
      throw new NativeGitBundleConfigError("ordinary CI bundle host capacities must be unique");
    }
  }
  assertDistinctCredentials([
    config.credentials.webhook,
    config.credentials.registrar,
    config.credentials.query,
    config.nativeGit.identity,
    config.nativeGit.attemptIssuer,
    config.nativeGit.resultReporter
  ], config.hosts.map((entry) => entry.hostToken));
  return config;
}

export function parseNativeGitBundle(
  nativeInput: unknown,
  ordinaryInput: unknown
): { readonly native: NativeGitBundleConfig; readonly ordinary: OrdinaryBundleConfig } {
  const native = parseNativeGitBundleConfig(nativeInput);
  const ordinary = parseOrdinaryBundleConfig(ordinaryInput);
  if (native.serviceId !== ordinary.nativeGit.serviceId
    || native.ordinaryCi.serviceId !== ordinary.serviceId) {
    throw new NativeGitBundleConfigError("bundle service IDs are not reciprocal");
  }
  assertPairedCredential("query", native.ordinaryCi.query, ordinary.credentials.query);
  assertPairedCredential("webhook", native.ordinaryCi.webhook, ordinary.credentials.webhook);
  assertPairedCredential("identity", native.ordinaryCi.identity, ordinary.nativeGit.identity);
  assertPairedCredential("attempt issuer", native.ordinaryCi.attemptIssuer, ordinary.nativeGit.attemptIssuer);
  assertPairedCredential("result reporter", native.ordinaryCi.resultReporter, ordinary.nativeGit.resultReporter);
  return { native, ordinary };
}

export class NativeGitBundleConfigError extends Error {
  readonly name = "NativeGitBundleConfigError";
}

type Credential = { readonly username: string; readonly password: string };

function assertDistinctCredentials(credentials: readonly Credential[], tokens: readonly string[] = []): void {
  const values = [...credentials.flatMap((entry) => [entry.username, entry.password]), ...tokens];
  if (new Set(values).size !== values.length) {
    throw new NativeGitBundleConfigError("bundle credentials must be globally distinct");
  }
}

function assertPairedCredential(label: string, native: Credential, ordinary: Credential): void {
  if (native.username !== ordinary.username || native.password !== ordinary.password) {
    throw new NativeGitBundleConfigError(`bundle paired ${label} credential does not match`);
  }
}
