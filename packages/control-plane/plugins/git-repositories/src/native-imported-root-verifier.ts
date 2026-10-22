import { readEffectiveRepositoryPolicy } from "./repository-policy-state.js";
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
} from "./repository-ref-state.js";
import { assertOwnedNativeProjectStorage } from "./native-project-storage.js";
import { inspectImportedNativeRootReadOnly } from "./native-root-import-proof-git.js";
import { assertDurableNativeRootBundle, assertPrivateDirectory } from "./native-root-import-storage.js";
import type { GitExecutableIdentity } from "./repository.js";

export type LiveImportedRoot = {
  readonly imported: NativeProjectRootImportInstalled;
  readonly importReceipt: NativeProjectRootImportInstalled;
  readonly currentHead: NativeProjectRootCurrentHead;
  readonly repository: string;
};

type ImportedRootInput = {
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly ownerHostId: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly state: NativeGitBundleState;
  readonly stateDirectory: string;
};

type LiveImportedRootInput = ImportedRootInput & {
  readonly activated: boolean;
  readonly activationTokenDigest: string;
  readonly expectedGenerationId: string;
};

export async function verifyLiveImportedRepository(input: LiveImportedRootInput): Promise<LiveImportedRoot> {
  assertActive(input);
  const result = await verifyImportedRepositoryReadOnly(input);
  assertActive(input);
  return result;
}

export async function verifyImportedRepositoryReadOnly(input: ImportedRootInput): Promise<LiveImportedRoot> {
  const registration = readNativeProjectRegistrationsFromDatabase(input.state.database)
    .find((entry) => entry.projectId === input.projectId && entry.repositoryId === input.repositoryId);
  if (registration === undefined || registration.ownerHostId !== input.ownerHostId) {
    throw new NativeImportedRootNotFoundError();
  }
  const imported = requireImportedRoot(input);
  if (registration.phase !== "repository-prepared" || registration.serviceId !== imported.serviceId
    || registration.repositoryId !== imported.repositoryId) {
    throw new NativeProjectRootImportStateError("native Project imported root registration binding is invalid");
  }
  const currentHead = readNativeProjectRootCurrentHeadFromDatabase(input.state.database, imported.projectId, imported.repositoryId);
  const repository = join(input.stateDirectory, input.projectId, `${input.repositoryId}.git`);
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
    .find((entry) => entry.projectId === input.projectId && entry.repositoryId === input.repositoryId);
  const rereadHead = readNativeProjectRootCurrentHeadFromDatabase(input.state.database, current.projectId, current.repositoryId);
  if (JSON.stringify(current) !== JSON.stringify(imported)
    || JSON.stringify(currentRegistration) !== JSON.stringify(registration)
    || JSON.stringify(rereadHead) !== JSON.stringify(currentHead)) {
    throw new NativeProjectRootImportStateError("native Project imported root changed during proof");
  }
  const effective = readEffectiveRepositoryPolicy(input.state.database, imported.projectId, imported.repositoryId);
  if (effective.policyDigest !== currentHead.policyDigest) throw new NativeProjectRootImportStateError("repository policy changed during proof");
  return { imported: { ...imported, ...effective }, importReceipt: imported, currentHead, repository };
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
  await assertDurableNativeRootBundle(input.stateDirectory, input.projectId, input.repositoryId, imported.importNonce,
    imported.bundleDigest, imported.bundleSize);
}

function requireImportedRoot(input: ImportedRootInput): NativeProjectRootImportInstalled {
  const imported = readNativeProjectRootImportsFromDatabase(input.state.database)
    .find((entry) => entry.projectId === input.projectId && entry.repositoryId === input.repositoryId);
  if (imported === undefined || imported.ownerHostId !== input.ownerHostId
    || imported.phase !== "repository-imported") {
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
