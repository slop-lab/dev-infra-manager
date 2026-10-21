import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readdir } from "node:fs/promises";
import type { ControlPlaneConfig } from "./controlPlaneConfig.js";
import type { CompleteControlPlaneSourcePreflight, ControlPlaneSources } from "./controlPlaneSources.js";
import {
  assertControlPlaneStagedSources as assertStagedSourcesAtRoot,
  controlPlaneSnapshotNames,
  controlPlaneGenerationIdFromFields,
  controlPlaneGenerationId,
  discardControlPlaneStaging as discardStagingAtRoot,
  finalizeControlPlaneGeneration as finalizeGenerationAtRoot,
  stageControlPlaneSources as stageSourcesAtRoot,
  type ControlPlaneCandidateGeneration,
  type ControlPlaneStaging
} from "./controlPlaneGeneration.js";
import {
  completeControlPlanePublication,
  completeControlPlaneRollback,
  markControlPlanePublication,
  markFailedFirstControlPlaneInstall
} from "./controlPlaneJournal.js";
import {
  assertStateDirectory,
  errorCode,
  readStateFile,
  replaceStateFile
} from "./controlPlaneStateFs.js";
import {
  assertComposeMatches,
  assertSnapshotDigests,
  ControlPlaneStateError,
  digest,
  generationDirectories,
  installedRecordBytes,
  parseInstalledRecord,
  readGeneration,
  validateOptionalLock,
  type ControlPlaneInstalledRecord,
  type ControlPlaneSnapshotBytes
} from "./controlPlaneStateValidation.js";
import { assertControlPlaneStateLock, type ControlPlaneStateLock } from "./controlPlaneLock.js";

export type ControlPlaneInstalledState = {
  readonly record: ControlPlaneInstalledRecord;
  readonly installBytes: Buffer;
  readonly composeBytes: Buffer;
  readonly generationPath: string;
  readonly snapshots: ControlPlaneSnapshotBytes;
};

export function defaultControlPlaneStateRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const base = environment.XDG_STATE_HOME ?? join(environment.HOME ?? homedir(), ".local", "state");
  if (!isAbsolute(base)) throw new ControlPlaneStateError("control-plane state home must be absolute");
  return join(base, "dim", "control-plane");
}

export async function readControlPlaneInstalledState(lock: ControlPlaneStateLock): Promise<ControlPlaneInstalledState | undefined> {
  assertControlPlaneStateLock(lock);
  const root = lock.root;
  try {
    await assertStateDirectory(root);
  } catch (error) {
    if (errorCauseCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const entries = await readdir(root);
  if (entries.includes("transaction.json")) {
    await readStateFile(join(root, "transaction.json"), 0o600, 4 * 1024 * 1024);
    throw new ControlPlaneStateError("control-plane state contains an incomplete transaction; automatic adoption is forbidden");
  }
  const allowed = new Set(["install.lock", "generations", "install.json", "compose.yml"]);
  if (entries.some((entry) => !allowed.has(entry))) throw new ControlPlaneStateError("control-plane state contains an unknown artifact");
  await validateOptionalLock(root, entries);
  const hasInstall = entries.includes("install.json");
  const hasCompose = entries.includes("compose.yml");
  if (hasInstall !== hasCompose) throw new ControlPlaneStateError("control-plane installed record and Compose bytes must exist together");
  const generationIds = await generationDirectories(root, entries.includes("generations"));
  if (!hasInstall) {
    if (generationIds.length !== 0) throw new ControlPlaneStateError("control-plane state contains an unrecorded generation");
    return undefined;
  }
  const installBytes = await readStateFile(join(root, "install.json"), 0o600, 64 * 1024);
  const record = parseInstalledRecord(installBytes);
  if (!generationIds.includes(record.generationId)) throw new ControlPlaneStateError("recorded control-plane generation is missing");
  const composeBytes = await readStateFile(join(root, "compose.yml"), 0o600, 1024 * 1024);
  if (digest(composeBytes) !== record.composeSha256) throw new ControlPlaneStateError("control-plane Compose digest is inconsistent");
  const generationPath = join(root, "generations", record.generationId);
  const snapshots = await readGeneration(generationPath);
  assertSnapshotDigests(record, snapshots);
  const generationId = controlPlaneGenerationIdFromFields([
    Buffer.from(record.nativeGitImage), Buffer.from(record.executionImage),
    snapshots.nativeGit.config, snapshots.nativeGit.readinessToken,
    snapshots.execution.config, snapshots.execution.readinessToken,
    snapshots.nativeGit.activationToken, snapshots.execution.activationToken
  ]);
  if (generationId !== record.generationId) throw new ControlPlaneStateError("control-plane generation ID is inconsistent");
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
      execution: {
        config: join(generationPath, names.execution.config),
        readinessToken: join(generationPath, names.execution.readinessToken),
        activationToken: join(generationPath, names.execution.activationToken)
      }
    },
    snapshots
  });
  return { record, installBytes, composeBytes, generationPath, snapshots };
}

export function isControlPlaneInstalledInput(
  installed: ControlPlaneInstalledState,
  config: ControlPlaneConfig,
  sources: ControlPlaneSources
): boolean {
  return installed.record.deploymentId === config.deploymentId
    && installed.record.nativeGitImage === config.nativeGit.image
    && installed.record.executionImage === config.execution.image
    && installed.record.nativeGitPublish.host === config.nativeGit.publish.host
    && installed.record.nativeGitPublish.port === config.nativeGit.publish.port
    && installed.record.executionPublish.host === config.execution.publish.host
    && installed.record.executionPublish.port === config.execution.publish.port
    && installed.record.nativeGitConfigSha256 === sources.nativeGit.config.sha256
    && installed.record.nativeGitReadinessTokenSha256 === sources.nativeGit.readinessToken.sha256
    && installed.record.executionConfigSha256 === sources.execution.config.sha256
    && installed.record.executionReadinessTokenSha256 === sources.execution.readinessToken.sha256;
}

export async function stageControlPlaneSources(input: {
  readonly lock: ControlPlaneStateLock;
  readonly sources: ControlPlaneSources;
  readonly prior: ControlPlaneInstalledState | undefined;
}): Promise<ControlPlaneStaging> {
  assertControlPlaneStateLock(input.lock);
  return await stageSourcesAtRoot({ root: input.lock.root, sources: input.sources, prior: input.prior });
}

export async function finalizeControlPlaneGeneration(input: {
  readonly lock: ControlPlaneStateLock;
  readonly staging: ControlPlaneStaging;
  readonly config: ControlPlaneConfig;
  readonly sources: CompleteControlPlaneSourcePreflight;
}): Promise<ControlPlaneCandidateGeneration> {
  assertControlPlaneStateLock(input.lock, input.staging.root);
  return await finalizeGenerationAtRoot({ staging: input.staging, config: input.config, sources: input.sources });
}

export async function assertControlPlaneStagedSources(input: {
  readonly lock: ControlPlaneStateLock;
  readonly staging: ControlPlaneStaging;
  readonly sources: ControlPlaneSources;
}): Promise<void> {
  assertControlPlaneStateLock(input.lock, input.staging.root);
  await assertStagedSourcesAtRoot(input.staging, input.sources);
}

export async function discardControlPlaneStaging(lock: ControlPlaneStateLock, staging: ControlPlaneStaging): Promise<void> {
  assertControlPlaneStateLock(lock, staging.root);
  await discardStagingAtRoot(staging);
}

export async function publishControlPlaneInstalledState(
  lock: ControlPlaneStateLock,
  candidate: ControlPlaneCandidateGeneration,
  publication: { readonly volumesEstablished: true }
): Promise<void> {
  assertControlPlaneStateLock(lock, candidate.staging.root);
  await markControlPlanePublication(candidate);
  const record: ControlPlaneInstalledRecord = {
    schemaVersion: 1,
    deploymentId: candidate.config.deploymentId,
    generationId: candidate.generationId,
    composeSha256: digest(candidate.composeBytes),
    nativeGitImage: candidate.config.nativeGit.image,
    executionImage: candidate.config.execution.image,
    nativeGitPublish: candidate.config.nativeGit.publish,
    executionPublish: candidate.config.execution.publish,
    nativeGitConfigSha256: candidate.sourceDigests.nativeGitConfig,
    nativeGitReadinessTokenSha256: candidate.sourceDigests.nativeGitReadinessToken,
    executionConfigSha256: candidate.sourceDigests.executionConfig,
    executionReadinessTokenSha256: candidate.sourceDigests.executionReadinessToken,
    nativeGitActivationTokenSha256: candidate.activationDigests.nativeGit,
    executionActivationTokenSha256: candidate.activationDigests.execution,
    volumesEstablished: publication.volumesEstablished
  };
  await replaceStateFile(join(candidate.staging.root, "compose.yml"), candidate.composeBytes);
  await replaceStateFile(join(candidate.staging.root, "install.json"), installedRecordBytes(record));
}

export async function completeControlPlaneInstalledState(
  lock: ControlPlaneStateLock,
  candidate: ControlPlaneCandidateGeneration
): Promise<void> {
  assertControlPlaneStateLock(lock, candidate.staging.root);
  await completeControlPlanePublication(candidate);
}

export async function restorePriorControlPlaneInstalledState(
  lock: ControlPlaneStateLock,
  candidate: ControlPlaneCandidateGeneration,
  prior: ControlPlaneInstalledState
): Promise<void> {
  assertControlPlaneStateLock(lock, candidate.staging.root);
  if (candidate.staging.prior?.record.generationId !== prior.record.generationId
    || !candidate.staging.prior.installBytes.equals(prior.installBytes)
    || !candidate.staging.prior.composeBytes.equals(prior.composeBytes)) {
    throw new ControlPlaneStateError("control-plane rollback prior state does not match the transaction journal");
  }
  await replaceStateFile(join(candidate.staging.root, "compose.yml"), prior.composeBytes);
  await replaceStateFile(join(candidate.staging.root, "install.json"), prior.installBytes);
}

export async function completeControlPlaneInstalledRollback(
  lock: ControlPlaneStateLock,
  candidate: ControlPlaneCandidateGeneration
): Promise<void> {
  assertControlPlaneStateLock(lock, candidate.staging.root);
  await completeControlPlaneRollback(candidate);
}

export async function recordFailedFirstControlPlaneInstall(
  lock: ControlPlaneStateLock,
  candidate: ControlPlaneCandidateGeneration
): Promise<void> {
  assertControlPlaneStateLock(lock, candidate.staging.root);
  await markFailedFirstControlPlaneInstall(candidate);
}

export {
  ControlPlaneStateError,
  controlPlaneGenerationId,
  type ControlPlaneInstalledRecord,
  type ControlPlaneCandidateGeneration,
  type ControlPlaneStaging
};

function errorCauseCode(error: unknown): string | undefined {
  if (errorCode(error) !== undefined) return errorCode(error);
  return error instanceof Error ? errorCode(error.cause) : undefined;
}
