import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { controlPlaneLocalAddresses, type ControlPlanePublish } from "./controlPlaneConfig.js";
import { renderControlPlaneCompose, type ControlPlaneSnapshotPaths } from "./controlPlaneCompose.js";
import { controlPlaneSnapshotNames } from "./controlPlaneGeneration.js";
import { assertStateDirectory, readStateFile } from "./controlPlaneStateFs.js";

const generationPattern = /^[0-9a-f]{64}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const imagePattern = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;
const deploymentPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const recordKeys = [
  "schemaVersion", "deploymentId", "generationId", "composeSha256", "nativeGitImage", "executionImage",
  "nativeGitPublish", "executionPublish",
  "nativeGitConfigSha256", "nativeGitReadinessTokenSha256", "executionConfigSha256",
  "executionReadinessTokenSha256", "nativeGitActivationTokenSha256", "executionActivationTokenSha256",
  "volumesEstablished"
] as const;

export type ControlPlaneInstalledRecord = {
  readonly schemaVersion: 1;
  readonly deploymentId: string;
  readonly generationId: string;
  readonly composeSha256: string;
  readonly nativeGitImage: string;
  readonly executionImage: string;
  readonly nativeGitPublish: ControlPlanePublish;
  readonly executionPublish: ControlPlanePublish;
  readonly nativeGitConfigSha256: string;
  readonly nativeGitReadinessTokenSha256: string;
  readonly executionConfigSha256: string;
  readonly executionReadinessTokenSha256: string;
  readonly nativeGitActivationTokenSha256: string;
  readonly executionActivationTokenSha256: string;
  readonly volumesEstablished: true;
};

export type ControlPlaneSnapshotBytes = {
  readonly nativeGit: { readonly config: Buffer; readonly readinessToken: Buffer; readonly activationToken: Buffer };
  readonly execution: { readonly config: Buffer; readonly readinessToken: Buffer; readonly activationToken: Buffer };
};

export async function generationDirectories(root: string, present: boolean): Promise<readonly string[]> {
  if (!present) return [];
  const generations = join(root, "generations");
  await assertStateDirectory(generations);
  const entries = await readdir(generations, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !generationPattern.test(entry.name)) {
      throw new ControlPlaneStateError("control-plane generations contain an invalid entry");
    }
    await assertStateDirectory(join(generations, entry.name));
    await readGeneration(join(generations, entry.name));
  }
  return entries.map((entry) => entry.name);
}

export async function readGeneration(path: string): Promise<ControlPlaneSnapshotBytes> {
  const names = controlPlaneSnapshotNames();
  const expected = [...Object.values(names.nativeGit), ...Object.values(names.execution)].sort();
  const actual = (await readdir(path)).sort();
  if (actual.length !== expected.length || expected.some((name, index) => actual[index] !== name)) {
    throw new ControlPlaneStateError("control-plane generation snapshot set is invalid");
  }
  return {
    nativeGit: {
      config: await readStateFile(join(path, names.nativeGit.config), 0o444, 1024 * 1024),
      readinessToken: await readStateFile(join(path, names.nativeGit.readinessToken), 0o444, 4096),
      activationToken: await readStateFile(join(path, names.nativeGit.activationToken), 0o444, 4096)
    },
    execution: {
      config: await readStateFile(join(path, names.execution.config), 0o444, 1024 * 1024),
      readinessToken: await readStateFile(join(path, names.execution.readinessToken), 0o444, 4096),
      activationToken: await readStateFile(join(path, names.execution.activationToken), 0o444, 4096)
    }
  };
}

export function parseInstalledRecord(
  bytes: Buffer,
  localAddresses: readonly string[] = controlPlaneLocalAddresses()
): ControlPlaneInstalledRecord {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ControlPlaneStateError("control-plane installed record is not JSON", { cause: error });
    throw error;
  }
  if (!isRecord(value) || Object.keys(value).length !== recordKeys.length || recordKeys.some((key) => !Object.hasOwn(value, key))
    || value.schemaVersion !== 1 || typeof value.deploymentId !== "string" || !deploymentPattern.test(value.deploymentId)
    || typeof value.generationId !== "string" || !generationPattern.test(value.generationId)
    || typeof value.nativeGitImage !== "string" || !imagePattern.test(value.nativeGitImage)
    || typeof value.executionImage !== "string" || !imagePattern.test(value.executionImage)
    || value.volumesEstablished !== true) {
    throw new ControlPlaneStateError("control-plane installed record schema is invalid");
  }
  const nativeGitPublish = publishField(value, "nativeGitPublish", localAddresses);
  const executionPublish = publishField(value, "executionPublish", localAddresses);
  if (nativeGitPublish.port === executionPublish.port) {
    throw new ControlPlaneStateError("control-plane installed record published ports must be distinct");
  }
  return {
    schemaVersion: 1,
    deploymentId: value.deploymentId,
    generationId: value.generationId,
    composeSha256: digestField(value, "composeSha256"),
    nativeGitImage: value.nativeGitImage,
    executionImage: value.executionImage,
    nativeGitPublish,
    executionPublish,
    nativeGitConfigSha256: digestField(value, "nativeGitConfigSha256"),
    nativeGitReadinessTokenSha256: digestField(value, "nativeGitReadinessTokenSha256"),
    executionConfigSha256: digestField(value, "executionConfigSha256"),
    executionReadinessTokenSha256: digestField(value, "executionReadinessTokenSha256"),
    nativeGitActivationTokenSha256: digestField(value, "nativeGitActivationTokenSha256"),
    executionActivationTokenSha256: digestField(value, "executionActivationTokenSha256"),
    volumesEstablished: true
  };
}

export function assertSnapshotDigests(record: ControlPlaneInstalledRecord, snapshots: ControlPlaneSnapshotBytes): void {
  const actual = [
    digest(snapshots.nativeGit.config), digest(snapshots.nativeGit.readinessToken),
    digest(snapshots.execution.config), digest(snapshots.execution.readinessToken),
    digest(snapshots.nativeGit.activationToken), digest(snapshots.execution.activationToken)
  ];
  const expected = [
    record.nativeGitConfigSha256, record.nativeGitReadinessTokenSha256,
    record.executionConfigSha256, record.executionReadinessTokenSha256,
    record.nativeGitActivationTokenSha256, record.executionActivationTokenSha256
  ];
  if (actual.some((value, index) => value !== expected[index])) throw new ControlPlaneStateError("control-plane snapshot digest is inconsistent");
}

export function assertComposeMatches(input: {
  readonly compose: Buffer;
  readonly record: ControlPlaneInstalledRecord;
  readonly snapshotPaths: ControlPlaneSnapshotPaths;
  readonly snapshots: ControlPlaneSnapshotBytes;
}): void {
  const expected = renderControlPlaneCompose({
    generationId: input.record.generationId,
    config: {
      deploymentId: input.record.deploymentId,
      nativeGit: { image: input.record.nativeGitImage, publish: input.record.nativeGitPublish },
      execution: { image: input.record.executionImage, publish: input.record.executionPublish }
    },
    snapshots: input.snapshotPaths,
    operatorSourcePaths: [],
    forbiddenSecrets: []
  });
  if (!input.compose.equals(expected)) throw new ControlPlaneStateError("control-plane Compose bytes are inconsistent with installed state");
  const secretBytes = [
    input.snapshots.nativeGit.config, input.snapshots.nativeGit.readinessToken, input.snapshots.nativeGit.activationToken,
    input.snapshots.execution.config, input.snapshots.execution.readinessToken, input.snapshots.execution.activationToken
  ];
  if (secretBytes.some((bytes) => bytes.length > 0 && input.compose.includes(bytes))) {
    throw new ControlPlaneStateError("control-plane Compose contains snapshot secret bytes");
  }
}

function publishField(
  record: Readonly<Record<string, unknown>>,
  key: "nativeGitPublish" | "executionPublish",
  localAddresses: readonly string[]
): ControlPlanePublish {
  const value = record[key];
  if (!isRecord(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "host") || !Object.hasOwn(value, "port")
    || typeof value.host !== "string" || isIP(value.host) === 0
    || typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65_535) {
    throw new ControlPlaneStateError(`control-plane installed record ${key} is invalid`);
  }
  const host = normalizeAddress(value.host);
  if (!new Set(localAddresses.map(normalizeAddress)).has(host)) {
    throw new ControlPlaneStateError(`control-plane installed record ${key} host is not local`);
  }
  return { host, port: value.port };
}

function normalizeAddress(address: string): string {
  const scope = address.indexOf("%");
  return (scope === -1 ? address : address.slice(0, scope)).toLowerCase();
}

export async function validateOptionalLock(root: string, entries: readonly string[]): Promise<void> {
  if (entries.includes("install.lock")) await readStateFile(join(root, "install.lock"), 0o600, 64 * 1024);
}

export function installedRecordBytes(record: ControlPlaneInstalledRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
}

export function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestField(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new ControlPlaneStateError(`control-plane installed record ${key} digest is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ControlPlaneStateError extends Error {
  readonly name = "ControlPlaneStateError";
}
