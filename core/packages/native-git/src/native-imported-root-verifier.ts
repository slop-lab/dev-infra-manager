import { join } from "node:path";
import { exactActivationIsBound } from "./native-bundle-activation.js";
import type { NativeGitBundleState } from "./native-bundle-state.js";
import {
  NativeProjectRootImportStateError,
  type NativeProjectRootImportInstalled
} from "./native-project-root-import-codec.js";
import { readNativeProjectRootImportsFromDatabase } from "./native-project-root-import-transitions.js";
import { readNativeProjectRegistrationsFromDatabase } from "./native-project-registry-state.js";
import {
  readNativeProjectRootCurrentHeadFromDatabase,
  type NativeProjectRootCurrentHead
} from "./native-project-root-promotion-state.js";
import { assertOwnedNativeProjectStorage } from "./native-project-storage.js";
import { inspectImportedNativeRootReadOnly } from "./native-root-import-proof-git.js";
import { assertDurableNativeRootBundle, assertPrivateDirectory } from "./native-root-import-storage.js";
import type { GitExecutableIdentity } from "./repository.js";

export type LiveImportedRoot = {
  readonly imported: NativeProjectRootImportInstalled;
  readonly currentHead: NativeProjectRootCurrentHead;
  readonly repository: string;
};

type ImportedRootInput = {
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly ownerHostId: string;
  readonly projectId: string;
  readonly state: NativeGitBundleState;
  readonly stateDirectory: string;
};

type LiveImportedRootInput = ImportedRootInput & {
  readonly activated: boolean;
  readonly activationTokenDigest: string;
  readonly expectedGenerationId: string;
};

export async function verifyLiveImportedRoot(input: LiveImportedRootInput): Promise<LiveImportedRoot> {
  assertActive(input);
  const result = await verifyImportedRootReadOnly(input);
  assertActive(input);
  return result;
}

export async function verifyImportedRootReadOnly(input: ImportedRootInput): Promise<LiveImportedRoot> {
  const registration = readNativeProjectRegistrationsFromDatabase(input.state.database)
    .find((entry) => entry.projectId === input.projectId);
  if (registration === undefined || registration.ownerHostId !== input.ownerHostId) {
    throw new NativeImportedRootNotFoundError();
  }
  const imported = requireImportedRoot(input);
  if (registration.phase !== "root-prepared" || registration.serviceId !== imported.serviceId
    || registration.rootRepositoryId !== imported.rootRepositoryId) {
    throw new NativeProjectRootImportStateError("native Project imported root registration binding is invalid");
  }
  const currentHead = readCurrentHead(input.state.database, imported);
  const repository = join(input.stateDirectory, input.projectId, "root.git");
  await assertStableStorage(input, registration, imported, repository);
  await inspectImportedNativeRootReadOnly({
    gitExecutable: input.gitExecutable,
    gitIdentity: input.gitIdentity,
    repository,
    protectedRef: imported.protectedRef,
    importedCommit: imported.expectedCommit,
    importedTree: imported.resolvedTree,
    currentCommit: currentHead.commit,
    currentTree: currentHead.tree,
    signal: AbortSignal.timeout(30_000)
  });
  await assertStableStorage(input, registration, imported, repository);
  const current = requireImportedRoot(input);
  const currentRegistration = readNativeProjectRegistrationsFromDatabase(input.state.database)
    .find((entry) => entry.projectId === input.projectId);
  const rereadHead = readCurrentHead(input.state.database, current);
  if (JSON.stringify(current) !== JSON.stringify(imported)
    || JSON.stringify(currentRegistration) !== JSON.stringify(registration)
    || JSON.stringify(rereadHead) !== JSON.stringify(currentHead)) {
    throw new NativeProjectRootImportStateError("native Project imported root changed during proof");
  }
  return { imported, currentHead, repository };
}

function readCurrentHead(
  databasePath: string,
  imported: NativeProjectRootImportInstalled
): NativeProjectRootCurrentHead {
  if (imported.policyFormat === "authoritative-v1") {
    return readNativeProjectRootCurrentHeadFromDatabase(databasePath, imported.projectId);
  }
  return {
    projectId: imported.projectId,
    sequence: 0,
    protectedRef: imported.protectedRef,
    commit: imported.expectedCommit,
    tree: imported.resolvedTree,
    policyDigest: imported.policyDigest
  };
}

function assertActive(input: LiveImportedRootInput): void {
  if (!input.activated || !exactActivationIsBound(
    input.state, input.expectedGenerationId, input.activationTokenDigest
  )) {
    throw new NativeImportedRootInactiveError();
  }
}

async function assertStableStorage(
  input: ImportedRootInput,
  registration: ReturnType<typeof readNativeProjectRegistrationsFromDatabase>[number],
  imported: NativeProjectRootImportInstalled,
  repository: string
): Promise<void> {
  await assertOwnedNativeProjectStorage(input.stateDirectory, registration);
  await assertPrivateDirectory(repository);
  await assertDurableNativeRootBundle(input.stateDirectory, input.projectId, imported.importNonce,
    imported.bundleDigest, imported.bundleSize);
}

function requireImportedRoot(input: ImportedRootInput): NativeProjectRootImportInstalled {
  const imported = readNativeProjectRootImportsFromDatabase(input.state.database)
    .find((entry) => entry.projectId === input.projectId);
  if (imported === undefined || imported.ownerHostId !== input.ownerHostId
    || imported.phase !== "root-imported") {
    throw new NativeProjectRootImportStateError("native Project imported root is unavailable");
  }
  return imported;
}

export class NativeImportedRootInactiveError extends Error {
  readonly name = "NativeImportedRootInactiveError";
}

export class NativeImportedRootNotFoundError extends Error {
  readonly name = "NativeImportedRootNotFoundError";
}
