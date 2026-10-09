import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ControlPlaneConfig } from "./controlPlaneConfig.js";
import { inspectControlPlaneDocker } from "./controlPlaneDockerInspect.js";
import { ProcessControlPlaneDockerRunner } from "./controlPlaneDockerRunner.js";
import type { ControlPlaneDockerRunner } from "./controlPlaneDockerTypes.js";
import { ControlPlaneInstallError } from "./controlPlaneInstallError.js";
import { activateControlPlaneTarget, validateControlPlaneNoOp } from "./controlPlaneInstallTransaction.js";
import { controlPlaneSnapshotNames, controlPlaneGenerationIdFromFields } from "./controlPlaneGeneration.js";
import { acquireControlPlaneStateLock, assertControlPlaneStateLock, type ControlPlaneStateLock } from "./controlPlaneLock.js";
import type { ControlPlaneReadinessPolicy } from "./controlPlaneReadiness.js";
import type { ControlPlaneInstalledState } from "./controlPlaneState.js";
import { assertStateDirectory, readStateFile, removeStateFile } from "./controlPlaneStateFs.js";
import {
  assertComposeMatches,
  assertSnapshotDigests,
  digest,
  generationDirectories,
  installedRecordBytes,
  parseInstalledRecord,
  readGeneration,
  validateOptionalLock
} from "./controlPlaneStateValidation.js";

const generationPattern = /^[0-9a-f]{64}$/;
const transactionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type RollForwardControlPlaneOptions = {
  readonly stateRoot: string;
  readonly expectedGenerationId: string;
  readonly runner?: ControlPlaneDockerRunner;
  readonly readinessPolicy?: ControlPlaneReadinessPolicy;
};

type RecoveryJournal = {
  readonly transactionId: string;
  readonly candidateGenerationId: string;
  readonly prior: { readonly generationId: string; readonly installBytes: Buffer; readonly composeBytes: Buffer } | undefined;
};

export async function rollForwardControlPlane(
  options: RollForwardControlPlaneOptions
): Promise<ControlPlaneInstalledState> {
  if (!generationPattern.test(options.expectedGenerationId)) {
    throw new ControlPlaneInstallError("control-plane recovery generation ID is invalid");
  }
  const runner = options.runner ?? new ProcessControlPlaneDockerRunner();
  const lock = await acquireControlPlaneStateLock(options.stateRoot);
  try {
    const initial = await readRecoveryState(lock, options.expectedGenerationId);
    const docker = await inspectControlPlaneDocker(runner, initial.candidate.record.deploymentId, true);
    if (docker.kind !== "owned") throw new ControlPlaneInstallError("control-plane recovery requires complete owned Docker resources");
    await validateCandidate(runner, initial.candidate, options.readinessPolicy);
    await assertRecoveryUnchanged(lock, initial);
    await activateControlPlaneTarget(runner, {
      config: installedConfig(initial.candidate),
      generationPath: initial.candidate.generationPath,
      generationId: initial.candidate.record.generationId
    });
    await validateCandidate(runner, initial.candidate, options.readinessPolicy);
    await assertRecoveryUnchanged(lock, initial);
    await removeStateFile(join(lock.root, "transaction.json"));
    return initial.candidate;
  } finally {
    await lock.close();
  }
}

async function validateCandidate(
  runner: ControlPlaneDockerRunner,
  candidate: ControlPlaneInstalledState,
  readinessPolicy: ControlPlaneReadinessPolicy | undefined
): Promise<void> {
  await validateControlPlaneNoOp({
    runner,
    config: installedConfig(candidate),
    prior: candidate,
    ...(readinessPolicy === undefined ? {} : { readinessPolicy })
  });
}

async function assertRecoveryUnchanged(
  lock: ControlPlaneStateLock,
  initial: Awaited<ReturnType<typeof readRecoveryState>>
): Promise<void> {
  const current = await readRecoveryState(lock, initial.candidate.record.generationId);
  if (!current.journalBytes.equals(initial.journalBytes)
    || !current.candidate.installBytes.equals(initial.candidate.installBytes)
    || !current.candidate.composeBytes.equals(initial.candidate.composeBytes)) {
    throw new ControlPlaneInstallError("control-plane recovery evidence changed during activation");
  }
}

async function readRecoveryState(lock: ControlPlaneStateLock, expectedGenerationId: string): Promise<{
  readonly journalBytes: Buffer;
  readonly candidate: ControlPlaneInstalledState;
}> {
  assertControlPlaneStateLock(lock);
  await assertStateDirectory(lock.root);
  const entries = await readdir(lock.root);
  const allowed = new Set(["install.lock", "generations", "install.json", "compose.yml", "transaction.json"]);
  if (entries.some((entry) => !allowed.has(entry)) || !entries.includes("install.json")
    || !entries.includes("compose.yml") || !entries.includes("transaction.json") || !entries.includes("generations")) {
    throw new ControlPlaneInstallError("control-plane recovery state root is incomplete or contains an unknown artifact");
  }
  await validateOptionalLock(lock.root, entries);
  const journalBytes = await readStateFile(join(lock.root, "transaction.json"), 0o600, 4 * 1024 * 1024);
  const journal = parseRecoveryJournal(journalBytes, expectedGenerationId);
  const generationIds = await generationDirectories(lock.root, true);
  const expectedIds = journal.prior === undefined
    ? [expectedGenerationId]
    : [journal.prior.generationId, expectedGenerationId];
  if ((journal.prior === undefined && generationIds.length !== 1)
    || expectedIds.some((generationId) => !generationIds.includes(generationId))) {
    throw new ControlPlaneInstallError("control-plane recovery generation set does not match the journal");
  }
  const installBytes = await readStateFile(join(lock.root, "install.json"), 0o600, 64 * 1024);
  const composeBytes = await readStateFile(join(lock.root, "compose.yml"), 0o600, 1024 * 1024);
  const candidate = await retainedState(lock.root, installBytes, composeBytes);
  if (candidate.record.generationId !== expectedGenerationId) {
    throw new ControlPlaneInstallError("control-plane recovery candidate does not match the requested generation");
  }
  if (journal.prior !== undefined) {
    const prior = await retainedState(lock.root, journal.prior.installBytes, journal.prior.composeBytes);
    if (prior.record.generationId !== journal.prior.generationId
      || prior.record.generationId === candidate.record.generationId
      || prior.record.deploymentId !== candidate.record.deploymentId) {
      throw new ControlPlaneInstallError("control-plane recovery prior state does not match the candidate");
    }
  }
  return { journalBytes, candidate };
}

async function retainedState(root: string, installBytes: Buffer, composeBytes: Buffer): Promise<ControlPlaneInstalledState> {
  const record = parseInstalledRecord(installBytes);
  if (!installBytes.equals(installedRecordBytes(record)) || digest(composeBytes) !== record.composeSha256) {
    throw new ControlPlaneInstallError("control-plane recovery retained state is not canonical");
  }
  const generationPath = join(root, "generations", record.generationId);
  const snapshots = await readGeneration(generationPath);
  assertSnapshotDigests(record, snapshots);
  const generationId = controlPlaneGenerationIdFromFields([
    Buffer.from(record.nativeGitImage), Buffer.from(record.ordinaryCiImage),
    snapshots.nativeGit.config, snapshots.nativeGit.readinessToken,
    snapshots.ordinaryCi.config, snapshots.ordinaryCi.readinessToken,
    snapshots.nativeGit.activationToken, snapshots.ordinaryCi.activationToken
  ]);
  if (generationId !== record.generationId) throw new ControlPlaneInstallError("control-plane recovery generation ID is inconsistent");
  const names = controlPlaneSnapshotNames();
  assertComposeMatches({
    compose: composeBytes,
    record,
    snapshotPaths: {
      nativeGit: {
        config: join(generationPath, names.nativeGit.config),
        readinessToken: join(generationPath, names.nativeGit.readinessToken),
        activationToken: join(generationPath, names.nativeGit.activationToken)
      },
      ordinaryCi: {
        config: join(generationPath, names.ordinaryCi.config),
        readinessToken: join(generationPath, names.ordinaryCi.readinessToken),
        activationToken: join(generationPath, names.ordinaryCi.activationToken)
      }
    },
    snapshots
  });
  return { record, installBytes, composeBytes, generationPath, snapshots };
}

function parseRecoveryJournal(bytes: Buffer, expectedGenerationId: string): RecoveryJournal {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ControlPlaneInstallError("control-plane recovery journal is not JSON", { cause: error });
    throw error;
  }
  if (!isRecord(value) || Object.keys(value).length !== 6 || value.schemaVersion !== 1
    || typeof value.transactionId !== "string" || !transactionPattern.test(value.transactionId)
    || value.phase !== "publishing" || value.candidateGenerationId !== expectedGenerationId
    || value.stagingDirectory !== `.staging-${value.transactionId}`) {
    throw new ControlPlaneInstallError("control-plane recovery journal schema or identity is invalid");
  }
  return {
    transactionId: value.transactionId,
    candidateGenerationId: expectedGenerationId,
    prior: parsePrior(value.prior)
  };
}

function parsePrior(value: unknown): RecoveryJournal["prior"] {
  if (value === null) return undefined;
  if (!isRecord(value) || Object.keys(value).length !== 3 || typeof value.generationId !== "string"
    || !generationPattern.test(value.generationId) || typeof value.installBase64 !== "string"
    || typeof value.composeBase64 !== "string") {
    throw new ControlPlaneInstallError("control-plane recovery prior journal state is invalid");
  }
  const installBytes = canonicalBase64(value.installBase64, 64 * 1024);
  const composeBytes = canonicalBase64(value.composeBase64, 1024 * 1024);
  return { generationId: value.generationId, installBytes, composeBytes };
}

function canonicalBase64(value: string, maximumBytes: number): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximumBytes || bytes.toString("base64") !== value) {
    throw new ControlPlaneInstallError("control-plane recovery journal base64 is invalid");
  }
  return bytes;
}

function installedConfig(installed: ControlPlaneInstalledState): ControlPlaneConfig {
  const names = controlPlaneSnapshotNames();
  return {
    schemaVersion: 1,
    deploymentId: installed.record.deploymentId,
    nativeGit: {
      image: installed.record.nativeGitImage,
      configFile: join(installed.generationPath, names.nativeGit.config),
      readinessTokenFile: join(installed.generationPath, names.nativeGit.readinessToken),
      publish: installed.record.nativeGitPublish
    },
    ordinaryCi: {
      image: installed.record.ordinaryCiImage,
      configFile: join(installed.generationPath, names.ordinaryCi.config),
      readinessTokenFile: join(installed.generationPath, names.ordinaryCi.readinessToken),
      publish: installed.record.ordinaryCiPublish
    }
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
