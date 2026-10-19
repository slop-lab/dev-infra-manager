import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ControlPlaneConfig } from "./controlPlaneConfig.js";
import { renderControlPlaneCompose, type ControlPlaneSnapshotPaths } from "./controlPlaneCompose.js";
import type { CompleteControlPlaneSourcePreflight, ControlPlaneSources } from "./controlPlaneSources.js";
import { controlPlaneGenerationId } from "./controlPlaneGenerationId.js";
import { writeControlPlaneJournal } from "./controlPlaneJournal.js";
import {
  assertStateDirectory,
  ensureStateDirectory,
  errorCode,
  removeStateFile,
  readStateFile,
  syncStateDirectory,
  writeExclusiveStateFile
} from "./controlPlaneStateFs.js";

const generationPattern = /^[0-9a-f]{64}$/;
const snapshotNames = {
  nativeGit: {
    config: "native-git.json",
    readinessToken: "native-git-readiness.token",
    activationToken: "native-git-activation.token"
  },
  ordinaryCi: {
    config: "ordinary-ci.json",
    readinessToken: "ordinary-ci-readiness.token",
    activationToken: "ordinary-ci-activation.token"
  }
} as const;

export type ControlPlanePriorState = {
  readonly record: { readonly generationId: string };
  readonly installBytes: Buffer;
  readonly composeBytes: Buffer;
};

export type ControlPlaneStaging = {
  readonly root: string;
  readonly transactionId: string;
  readonly path: string;
  readonly prior: ControlPlanePriorState | undefined;
  readonly sourceDigests: {
    readonly nativeGitConfig: string;
    readonly nativeGitReadinessToken: string;
    readonly ordinaryCiConfig: string;
    readonly ordinaryCiReadinessToken: string;
  };
};

export type ControlPlaneCandidateGeneration = {
  readonly staging: ControlPlaneStaging;
  readonly generationId: string;
  readonly generationPath: string;
  readonly snapshots: ControlPlaneSnapshotPaths;
  readonly composeBytes: Buffer;
  readonly config: ControlPlaneConfig;
  readonly sourceDigests: ControlPlaneStaging["sourceDigests"];
  readonly activationDigests: { readonly nativeGit: string; readonly ordinaryCi: string };
};

export async function stageControlPlaneSources(input: {
  readonly root: string;
  readonly sources: ControlPlaneSources;
  readonly prior: ControlPlanePriorState | undefined;
}): Promise<ControlPlaneStaging> {
  await ensureStateDirectory(input.root);
  await assertNoTransaction(join(input.root, "transaction.json"));
  const generations = join(input.root, "generations");
  await ensureGenerationDirectory(generations);
  const transactionId = randomUUID();
  const path = join(input.root, `.staging-${transactionId}`);
  const staging: ControlPlaneStaging = {
    root: input.root,
    transactionId,
    path,
    prior: input.prior,
    sourceDigests: {
      nativeGitConfig: input.sources.nativeGit.config.sha256,
      nativeGitReadinessToken: input.sources.nativeGit.readinessToken.sha256,
      ordinaryCiConfig: input.sources.ordinaryCi.config.sha256,
      ordinaryCiReadinessToken: input.sources.ordinaryCi.readinessToken.sha256
    }
  };
  await writeControlPlaneJournal(staging, "staging");
  await mkdir(path, { mode: 0o700 });
  await syncStateDirectory(input.root);
  await Promise.all([
    writeExclusiveStateFile(join(path, snapshotNames.nativeGit.config), input.sources.nativeGit.config.bytes, 0o444),
    writeExclusiveStateFile(join(path, snapshotNames.nativeGit.readinessToken), input.sources.nativeGit.readinessToken.bytes, 0o444),
    writeExclusiveStateFile(join(path, snapshotNames.ordinaryCi.config), input.sources.ordinaryCi.config.bytes, 0o444),
    writeExclusiveStateFile(join(path, snapshotNames.ordinaryCi.readinessToken), input.sources.ordinaryCi.readinessToken.bytes, 0o444)
  ]);
  await syncStateDirectory(path);
  return staging;
}

export async function finalizeControlPlaneGeneration(input: {
  readonly staging: ControlPlaneStaging;
  readonly config: ControlPlaneConfig;
  readonly sources: CompleteControlPlaneSourcePreflight;
}): Promise<ControlPlaneCandidateGeneration> {
  await assertControlPlaneStagedSources(input.staging, input.sources);
  const generationId = controlPlaneGenerationId(input.config, input.sources);
  const generationPath = join(input.staging.root, "generations", generationId);
  await assertGenerationAbsent(generationPath);
  const stagedPaths = snapshotPaths(input.staging.path);
  await Promise.all([
    writeExclusiveStateFile(stagedPaths.nativeGit.activationToken, input.sources.activationTokens.nativeGit.bytes, 0o444),
    writeExclusiveStateFile(stagedPaths.ordinaryCi.activationToken, input.sources.activationTokens.ordinaryCi.bytes, 0o444)
  ]);
  await syncStateDirectory(input.staging.path);
  await rename(input.staging.path, generationPath);
  await syncStateDirectory(join(input.staging.root, "generations"));
  await writeControlPlaneJournal(input.staging, "generation", generationId);
  const snapshots = snapshotPaths(generationPath);
  const composeBytes = renderControlPlaneCompose({
    generationId,
    config: input.config,
    snapshots,
    operatorSourcePaths: [
      input.config.nativeGit.configFile,
      input.config.nativeGit.readinessTokenFile,
      input.config.ordinaryCi.configFile,
      input.config.ordinaryCi.readinessTokenFile
    ],
    forbiddenSecrets: input.sources.allSecretValues
  });
  return {
    staging: input.staging,
    generationId,
    generationPath,
    snapshots,
    composeBytes,
    config: input.config,
    sourceDigests: input.staging.sourceDigests,
    activationDigests: {
      nativeGit: input.sources.activationTokens.nativeGit.sha256,
      ordinaryCi: input.sources.activationTokens.ordinaryCi.sha256
    }
  };
}

export async function discardControlPlaneStaging(staging: ControlPlaneStaging): Promise<void> {
  await rm(staging.path, { recursive: true, force: true });
  await syncStateDirectory(staging.root);
  try {
    await removeStateFile(join(staging.root, "transaction.json"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export function controlPlaneSnapshotNames() {
  return snapshotNames;
}

function snapshotPaths(root: string): ControlPlaneSnapshotPaths {
  return {
    nativeGit: {
      config: join(root, snapshotNames.nativeGit.config),
      readinessToken: join(root, snapshotNames.nativeGit.readinessToken),
      activationToken: join(root, snapshotNames.nativeGit.activationToken)
    },
    ordinaryCi: {
      config: join(root, snapshotNames.ordinaryCi.config),
      readinessToken: join(root, snapshotNames.ordinaryCi.readinessToken),
      activationToken: join(root, snapshotNames.ordinaryCi.activationToken)
    }
  };
}

export async function assertControlPlaneStagedSources(
  staging: ControlPlaneStaging,
  sources: ControlPlaneSources
): Promise<void> {
  if (staging.sourceDigests.nativeGitConfig !== sources.nativeGit.config.sha256
    || staging.sourceDigests.nativeGitReadinessToken !== sources.nativeGit.readinessToken.sha256
    || staging.sourceDigests.ordinaryCiConfig !== sources.ordinaryCi.config.sha256
    || staging.sourceDigests.ordinaryCiReadinessToken !== sources.ordinaryCi.readinessToken.sha256) {
    throw new ControlPlaneGenerationError("completed source preflight does not match staged source bytes");
  }
  const paths = snapshotPaths(staging.path);
  const staged = await Promise.all([
    readStateFile(paths.nativeGit.config, 0o444, 1024 * 1024),
    readStateFile(paths.nativeGit.readinessToken, 0o444, 4096),
    readStateFile(paths.ordinaryCi.config, 0o444, 1024 * 1024),
    readStateFile(paths.ordinaryCi.readinessToken, 0o444, 4096)
  ]);
  const expected = [
    sources.nativeGit.config.bytes, sources.nativeGit.readinessToken.bytes,
    sources.ordinaryCi.config.bytes, sources.ordinaryCi.readinessToken.bytes
  ];
  if (staged.some((bytes, index) => {
    const expectedBytes = expected[index];
    return expectedBytes === undefined || !bytes.equals(expectedBytes);
  })) {
    throw new ControlPlaneGenerationError("staged source bytes do not match completed source preflight");
  }
}

async function assertGenerationAbsent(path: string): Promise<void> {
  if (!generationPattern.test(basename(path))) throw new ControlPlaneGenerationError("candidate generation ID is invalid");
  try {
    await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  throw new ControlPlaneGenerationError("candidate generation already exists and cannot be adopted or rewritten");
}

async function assertNoTransaction(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  throw new ControlPlaneGenerationError("control-plane state already contains an incomplete transaction");
}

async function ensureGenerationDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertStateDirectory(path);
}

export class ControlPlaneGenerationError extends Error {
  readonly name = "ControlPlaneGenerationError";
}

export { controlPlaneGenerationId, controlPlaneGenerationIdFromFields } from "./controlPlaneGenerationId.js";
