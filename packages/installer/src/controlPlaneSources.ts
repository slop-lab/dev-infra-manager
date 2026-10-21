import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import type { ControlPlaneConfig } from "./controlPlaneConfig.js";
import { ControlPlaneSourceError } from "./controlPlaneSourceError.js";
import { serviceCredentialValues } from "./controlPlaneServiceCredentials.js";

export { ControlPlaneSourceError } from "./controlPlaneSourceError.js";

const maximumServiceConfigBytes = 1024 * 1024;
const tokenPattern = /^[A-Za-z0-9_-]+$/;

export type PrivateControlPlaneFile = {
  readonly bytes: Buffer;
  readonly sha256: string;
};

export type ControlPlaneToken = PrivateControlPlaneFile & { readonly value: string };

export type ControlPlaneSources = {
  readonly nativeGit: { readonly config: PrivateControlPlaneFile; readonly readinessToken: ControlPlaneToken };
  readonly execution: { readonly config: PrivateControlPlaneFile; readonly readinessToken: ControlPlaneToken };
  readonly credentialValues: readonly string[];
  readonly roleValues: readonly string[];
  readonly serviceConfigPreflight: {
    readonly kind: "requires-image-validation";
    readonly reason: string;
  };
};

export type CompleteControlPlaneSourcePreflight = ControlPlaneSources & {
  readonly activationTokens: { readonly nativeGit: ControlPlaneToken; readonly execution: ControlPlaneToken };
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
  const [nativeConfig, nativeReadinessFile, executionConfig, executionReadinessFile] = await Promise.all([
    readPrivateControlPlaneFile(config.nativeGit.configFile, "native Git service config", maximumServiceConfigBytes),
    readPrivateControlPlaneFile(config.nativeGit.readinessTokenFile, "native Git readiness token", 4096),
    readPrivateControlPlaneFile(config.execution.configFile, "execution scheduler config", maximumServiceConfigBytes),
    readPrivateControlPlaneFile(config.execution.readinessTokenFile, "execution readiness token", 4096)
  ]);
  const nativeConfigValue = parseJson(nativeConfig.bytes, "native Git service config");
  const executionConfigValue = parseJson(executionConfig.bytes, "execution scheduler config");
  const { credentialValues, roleValues } = serviceCredentialValues(nativeConfigValue, executionConfigValue);
  const nativeReadiness = parseTokenFile(nativeReadinessFile, "native Git readiness token");
  const executionReadiness = parseTokenFile(executionReadinessFile, "execution readiness token");
  assertDistinct([...roleValues, nativeReadiness.value, executionReadiness.value]);
  return {
    nativeGit: { config: nativeConfig, readinessToken: nativeReadiness },
    execution: { config: executionConfig, readinessToken: executionReadiness },
    credentialValues,
    roleValues,
    serviceConfigPreflight: {
      kind: "requires-image-validation",
      reason: "candidate images must run check-config and native check-bundle-config before Docker mutation"
    }
  };
}

export function completeControlPlaneSourcePreflight(
  sources: ControlPlaneSources,
  activationBytes: { readonly nativeGit: Buffer; readonly execution: Buffer }
): CompleteControlPlaneSourcePreflight {
  const nativeGit = tokenFromBytes(activationBytes.nativeGit, "native Git activation token");
  const execution = tokenFromBytes(activationBytes.execution, "execution activation token");
  const allSecretValues = [
    ...sources.credentialValues,
    sources.nativeGit.readinessToken.value,
    sources.execution.readinessToken.value,
    nativeGit.value,
    execution.value
  ];
  assertDistinct([
    ...sources.roleValues,
    sources.nativeGit.readinessToken.value,
    sources.execution.readinessToken.value,
    nativeGit.value,
    execution.value
  ]);
  return { ...sources, activationTokens: { nativeGit, execution }, allSecretValues };
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

function assertDistinct(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new ControlPlaneSourceError("control-plane credential and token values must be distinct");
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
