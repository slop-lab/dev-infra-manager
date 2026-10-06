import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import type { ControlPlaneConfig } from "./controlPlaneConfig.js";

const maximumServiceConfigBytes = 1024 * 1024;
const tokenPattern = /^[A-Za-z0-9_-]+$/;

export type PrivateControlPlaneFile = {
  readonly bytes: Buffer;
  readonly sha256: string;
};

export type ControlPlaneToken = PrivateControlPlaneFile & { readonly value: string };

export type ControlPlaneSources = {
  readonly nativeGit: { readonly config: PrivateControlPlaneFile; readonly readinessToken: ControlPlaneToken };
  readonly ordinaryCi: { readonly config: PrivateControlPlaneFile; readonly readinessToken: ControlPlaneToken };
  readonly credentialValues: readonly string[];
  readonly serviceConfigPreflight: {
    readonly kind: "requires-image-validation";
    readonly reason: string;
  };
};

export type CompleteControlPlaneSourcePreflight = ControlPlaneSources & {
  readonly activationTokens: { readonly nativeGit: ControlPlaneToken; readonly ordinaryCi: ControlPlaneToken };
  readonly allSecretValues: readonly string[];
};

export async function readPrivateControlPlaneFile(
  target: string,
  label: string,
  maximumBytes: number
): Promise<PrivateControlPlaneFile> {
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new ControlPlaneSourceError(`${label} must be a non-symbolic-link mode-0600 regular file`, { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertPrivateMetadata(before, label, maximumBytes);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertPrivateMetadata(after, label, maximumBytes);
    if (metadataChanged(before, after) || BigInt(bytes.length) !== after.size) {
      throw new ControlPlaneSourceError(`${label} changed while it was read`);
    }
    return { bytes, sha256: digest(bytes) };
  } finally {
    await handle.close();
  }
}

export async function readControlPlaneSources(config: ControlPlaneConfig): Promise<ControlPlaneSources> {
  const [nativeConfig, nativeReadinessFile, ordinaryConfig, ordinaryReadinessFile] = await Promise.all([
    readPrivateControlPlaneFile(config.nativeGit.configFile, "native Git service config", maximumServiceConfigBytes),
    readPrivateControlPlaneFile(config.nativeGit.readinessTokenFile, "native Git readiness token", 4096),
    readPrivateControlPlaneFile(config.ordinaryCi.configFile, "ordinary CI service config", maximumServiceConfigBytes),
    readPrivateControlPlaneFile(config.ordinaryCi.readinessTokenFile, "ordinary CI readiness token", 4096)
  ]);
  const nativeConfigValue = parseJson(nativeConfig.bytes, "native Git service config");
  const ordinaryConfigValue = parseJson(ordinaryConfig.bytes, "ordinary CI service config");
  const credentialValues = serviceCredentialValues(nativeConfigValue, ordinaryConfigValue);
  const nativeReadiness = parseTokenFile(nativeReadinessFile, "native Git readiness token");
  const ordinaryReadiness = parseTokenFile(ordinaryReadinessFile, "ordinary CI readiness token");
  assertDistinct([...credentialValues, nativeReadiness.value, ordinaryReadiness.value]);
  return {
    nativeGit: { config: nativeConfig, readinessToken: nativeReadiness },
    ordinaryCi: { config: ordinaryConfig, readinessToken: ordinaryReadiness },
    credentialValues,
    serviceConfigPreflight: {
      kind: "requires-image-validation",
      reason: "candidate images must run check-config and native check-bundle-config before Docker mutation"
    }
  };
}

export function completeControlPlaneSourcePreflight(
  sources: ControlPlaneSources,
  activationBytes: { readonly nativeGit: Buffer; readonly ordinaryCi: Buffer }
): CompleteControlPlaneSourcePreflight {
  const nativeGit = tokenFromBytes(activationBytes.nativeGit, "native Git activation token");
  const ordinaryCi = tokenFromBytes(activationBytes.ordinaryCi, "ordinary CI activation token");
  const allSecretValues = [
    ...sources.credentialValues,
    sources.nativeGit.readinessToken.value,
    sources.ordinaryCi.readinessToken.value,
    nativeGit.value,
    ordinaryCi.value
  ];
  assertDistinct(allSecretValues);
  return { ...sources, activationTokens: { nativeGit, ordinaryCi }, allSecretValues };
}

export class ControlPlaneSourceError extends Error {
  readonly name = "ControlPlaneSourceError";
}

function assertPrivateMetadata(metadata: BigIntStats, label: string, maximumBytes: number): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new ControlPlaneSourceError(`${label} must be a regular file`);
  const uid = process.geteuid?.();
  if (uid === undefined || metadata.uid !== BigInt(uid)) throw new ControlPlaneSourceError(`${label} must be owned by the DIM user`);
  if (Number(metadata.mode & 0o777n) !== 0o600) throw new ControlPlaneSourceError(`${label} must have mode 0600`);
  if (metadata.nlink !== 1n) throw new ControlPlaneSourceError(`${label} must have exactly one link`);
  if (metadata.size > BigInt(maximumBytes)) throw new ControlPlaneSourceError(`${label} is too large`);
}

function metadataChanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || before.mode !== after.mode || before.uid !== after.uid || before.nlink !== after.nlink;
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ControlPlaneSourceError(`${label} must contain valid JSON`, { cause: error });
    throw error;
  }
}

function serviceCredentialValues(nativeValue: unknown, ordinaryValue: unknown): readonly string[] {
  const native = exactRecord(nativeValue, [
    "schemaVersion", "serviceId", "host", "port", "storageRoot", "gitExecutable", "gitVersion",
    "repositories", "identities", "ordinaryCi"
  ], "native Git service config");
  if (native.schemaVersion !== 2 || native.serviceId !== "native-main" || native.host !== "0.0.0.0"
    || native.port !== 8080 || native.storageRoot !== "/var/lib/dim-native-git"
    || !Array.isArray(native.repositories) || native.repositories.length !== 0
    || !Array.isArray(native.identities) || native.identities.length !== 0) {
    throw new ControlPlaneSourceError("native Git service config is not an idle bundle schema-2 config");
  }
  const nativeOrdinary = exactRecord(native.ordinaryCi, [
    "endpoint", "serviceId", "query", "identity", "attemptIssuer", "resultReporter", "webhook"
  ], "native Git ordinary CI config");
  const nativeRoles = ["query", "identity", "attemptIssuer", "resultReporter", "webhook"] as const;
  const nativeCredentials = nativeRoles.map((role) => credential(nativeOrdinary[role], `native Git ${role}`));

  const ordinary = exactRecord(ordinaryValue, [
    "schemaVersion", "serviceId", "database", "admissionLeaseMilliseconds", "claimLeaseMilliseconds",
    "nativeGit", "credentials", "hosts"
  ], "ordinary CI service config");
  if (ordinary.schemaVersion !== 3 || ordinary.serviceId !== "ordinary-main"
    || ordinary.database !== "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3") {
    throw new ControlPlaneSourceError("ordinary CI service config is not a bundle schema-3 config");
  }
  const ordinaryNative = exactRecord(ordinary.nativeGit,
    ["endpoint", "serviceId", "identity", "attemptIssuer", "resultReporter"], "ordinary CI native Git config");
  const roles = exactRecord(ordinary.credentials, ["webhook", "registrar", "query"], "ordinary CI credentials");
  const ordinaryCredentials = [
    credential(roles.webhook, "ordinary CI webhook"), credential(roles.registrar, "ordinary CI registrar"),
    credential(roles.query, "ordinary CI query"), credential(ordinaryNative.identity, "ordinary CI identity"),
    credential(ordinaryNative.attemptIssuer, "ordinary CI attempt issuer"),
    credential(ordinaryNative.resultReporter, "ordinary CI result reporter")
  ];
  assertPaired(nativeCredentials, ordinaryCredentials);
  if (!Array.isArray(ordinary.hosts) || ordinary.hosts.length === 0) {
    throw new ControlPlaneSourceError("ordinary CI service config must contain host credentials");
  }
  const hostTokens = ordinary.hosts.map((host, index) => {
    const value = exactRecord(host, ["hostId", "hostToken", "capacities"], `ordinary CI host ${index}`);
    if (!isToken(value.hostToken)) throw new ControlPlaneSourceError(`ordinary CI host ${index} token is invalid`);
    return value.hostToken;
  });
  const registrar = ordinaryCredentials[1];
  if (registrar === undefined) throw new ControlPlaneSourceError("ordinary CI registrar credential is missing");
  const values = [...nativeCredentials.map((entry) => entry.password), registrar.password, ...hostTokens];
  assertDistinct(values);
  return values;
}

type Credential = { readonly username: string; readonly password: string };

function credential(value: unknown, label: string): Credential {
  const input = exactRecord(value, value !== null && typeof value === "object" && Object.hasOwn(value, "endpoint")
    ? ["endpoint", "username", "password"] : ["username", "password"], label);
  if (typeof input.username !== "string" || !isToken(input.password)) {
    throw new ControlPlaneSourceError(`${label} credential is invalid`);
  }
  return { username: input.username, password: input.password };
}

function assertPaired(native: readonly Credential[], ordinary: readonly Credential[]): void {
  const pairs = [[0, 2], [1, 3], [2, 4], [3, 5], [4, 0]] as const;
  for (const [nativeIndex, ordinaryIndex] of pairs) {
    const left = native[nativeIndex];
    const right = ordinary[ordinaryIndex];
    if (left === undefined || right === undefined || left.username !== right.username || left.password !== right.password) {
      throw new ControlPlaneSourceError("native Git and ordinary CI paired credentials must match");
    }
  }
}

function parseTokenFile(file: PrivateControlPlaneFile, label: string): ControlPlaneToken {
  return tokenFromBytes(file.bytes, label, file.sha256);
}

function tokenFromBytes(bytes: Buffer, label: string, sha256 = digest(bytes)): ControlPlaneToken {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
    throw new ControlPlaneSourceError(`${label} file must contain exactly one token and one newline`);
  }
  const value = text.slice(0, -1);
  if (!isToken(value)) throw new ControlPlaneSourceError(`${label} is not a canonical base64url token of at least 32 bytes`);
  return { bytes: Buffer.from(bytes), sha256, value };
}

function isToken(value: unknown): value is string {
  if (typeof value !== "string" || !tokenPattern.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= 32 && decoded.toString("base64url") === value;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new ControlPlaneSourceError(`${label} has missing or unknown fields`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertDistinct(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new ControlPlaneSourceError("control-plane credential and token values must be distinct");
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
