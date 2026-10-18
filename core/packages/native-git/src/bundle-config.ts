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
const projectRegistrarToken = z.string().regex(/^[A-Za-z0-9_-]+$/).refine((value) => {
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
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
  jobBaseImage: z.string().regex(/^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/),
  bounds
}).strict().readonly();
const host = z.object({
  hostId: identifier,
  hostToken: bundleToken,
  capacities: z.array(capacity).min(1).readonly()
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

const nativeBundleConfigSchema = nativeGitServiceConfigSchema.unwrap().extend({
  schemaVersion: z.literal(7),
  repositories: z.array(nativeGitRepositorySchema).readonly(),
  identities: z.array(nativeGitIdentitySchema).readonly(),
  projectRegistrars: z.array(projectRegistrar).readonly(),
  projectRootImporters: z.array(projectRootImporter).readonly(),
  projectRootReadIssuers: z.array(projectRootReadIssuer).readonly(),
  workspaceWriteIssuers: z.array(workspaceWriteIssuer).readonly(),
  humanReviewers: z.array(humanReviewer).readonly(),
  hostPromoters: z.array(hostPromoter).readonly(),
  ordinaryCi: ordinaryCiDependencyConfigSchema.unwrap().extend({
    query: credential,
    identity: credential,
    attemptIssuer: credential,
    candidateReader: credential,
    resultReporter: credential,
    webhook: z.object({
      endpoint: z.literal("http://ordinary-ci:8080/v1/native-root-ci-events"),
      username: credentialUsername,
      password: bundleToken
    }).strict().readonly()
  }).strict().readonly(),
  qemuCi: z.object({
    endpoint: z.string().url(),
    serviceId: z.literal("qemu-main"),
    query: credential,
    eventIntake: credential,
    identity: credential,
    attemptIssuer: credential,
    candidateReader: credential,
    resultReporter: credential
  }).strict().readonly().optional()
}).strict().readonly();

const ordinaryBundleConfigSchema = z.object({
  schemaVersion: z.literal(5),
  serviceId: z.literal("ordinary-main"),
  database: z.literal("/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3"),
  eligibilityLeaseMilliseconds: z.number().int().positive(),
  claimLeaseMilliseconds: z.number().int().positive(),
  nativeGit: z.object({
    endpoint: z.literal("http://native-git:8080"),
    serviceId: z.literal("native-main"),
    identity: credential,
    attemptIssuer: credential,
    candidateReader: credential,
    resultReporter: credential
  }).strict().readonly(),
  credentials: z.object({
    webhook: credential,
    query: credential
  }).strict().readonly(),
  hosts: z.array(host).readonly()
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
    config.ordinaryCi.candidateReader,
    config.ordinaryCi.resultReporter,
    config.ordinaryCi.webhook,
    ...(config.qemuCi === undefined ? [] : [config.qemuCi.query, config.qemuCi.eventIntake, config.qemuCi.identity,
      config.qemuCi.attemptIssuer, config.qemuCi.candidateReader, config.qemuCi.resultReporter])
  ], [
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
  const serviceRoles = [config.ordinaryCi.query, config.ordinaryCi.identity, config.ordinaryCi.attemptIssuer,
    config.ordinaryCi.candidateReader, config.ordinaryCi.resultReporter, config.ordinaryCi.webhook,
    ...(config.qemuCi === undefined ? [] : [config.qemuCi.query, config.qemuCi.eventIntake, config.qemuCi.identity,
      config.qemuCi.attemptIssuer, config.qemuCi.candidateReader, config.qemuCi.resultReporter])];
  if ([...serviceRoles.flatMap((entry) => [entry.username, entry.password]),
    ...hostRoles.map((entry) => entry.password), ...config.humanReviewers.map((entry) => entry.password)]
    .some((value) => scopeIds.includes(value))) {
    throw new NativeGitBundleConfigError("bundle credentials must be globally distinct");
  }
  return config;
}

export function parseOrdinaryBundleConfig(input: unknown): OrdinaryBundleConfig {
  const result = ordinaryBundleConfigSchema.safeParse(input);
  if (!result.success) {
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
    config.credentials.query,
    config.nativeGit.identity,
    config.nativeGit.attemptIssuer,
    config.nativeGit.candidateReader,
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
  assertPairedCredential("candidate reader", native.ordinaryCi.candidateReader, ordinary.nativeGit.candidateReader);
  assertPairedCredential("result reporter", native.ordinaryCi.resultReporter, ordinary.nativeGit.resultReporter);
  assertDistinctValues([
    ...native.projectRegistrars.flatMap((entry) => [entry.username, entry.password]),
    ...native.projectRootImporters.flatMap((entry) => [entry.username, entry.password]),
    ...native.projectRootReadIssuers.flatMap((entry) => [entry.username, entry.password]),
    ...native.workspaceWriteIssuers.flatMap((entry) => [entry.username, entry.password]),
    ...native.humanReviewers.flatMap((entry) => [entry.username, entry.password]),
    ...native.hostPromoters.flatMap((entry) => [entry.username, entry.password]),
    ...ordinary.hosts.map((entry) => entry.hostToken)
  ]);
  if (native.projectRegistrars.some((entry) => ordinary.hosts.some((host) =>
    host.hostId === entry.username || host.hostId === entry.password))
    || native.projectRootImporters.some((entry) => ordinary.hosts.some((host) =>
      host.hostId === entry.username || host.hostId === entry.password))
    || native.projectRootReadIssuers.some((entry) => ordinary.hosts.some((host) =>
      host.hostId === entry.username || host.hostId === entry.password))
    || native.workspaceWriteIssuers.some((entry) => ordinary.hosts.some((host) =>
      host.hostId === entry.username || host.hostId === entry.password))
    || native.humanReviewers.some((entry) => ordinary.hosts.some((host) =>
      host.hostId === entry.reviewerId || host.hostId === entry.username || host.hostId === entry.password))
    || native.hostPromoters.some((entry) => ordinary.hosts.some((host) =>
      host.hostId === entry.username || host.hostId === entry.password))) {
    throw new NativeGitBundleConfigError("bundle credentials must be globally distinct");
  }
  return { native, ordinary };
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

function assertPairedCredential(label: string, native: Credential, ordinary: Credential): void {
  if (native.username !== ordinary.username || native.password !== ordinary.password) {
    throw new NativeGitBundleConfigError(`bundle paired ${label} credential does not match`);
  }
}
