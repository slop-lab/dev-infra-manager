import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  NativeProjectRegistrationConflictError,
  type NativeProjectRegistration,
  readNativeProjectRegistrationsFromDatabase,
  registerNativeProjectInDatabase
} from "./native-project-registry-state.js";
import {
  claimNativeProjectRootImportInDatabase,
  markNativeProjectRootBundleDurableInDatabase,
  type NativeProjectRootImport,
  type NativeProjectRootImportDurable,
  type NativeProjectRootImportInstalled
} from "./native-project-root-import-state.js";
import type { NativeProjectRootImportFinalizeSelector } from "./native-project-root-import-codec.js";
import {
  beginNativeProjectRootImportInstallationInDatabase,
  markNativeProjectRootImportedInDatabase,
  markNativeProjectRootObjectsInstalledInDatabase
} from "./native-project-root-import-transitions.js";
import {
  publishNativeGitBundleMarker,
  syncNativeGitBundlePath
} from "./native-bundle-state-marker.js";
import {
  createNativeGitBundleDatabase,
  expectedNativeGitBundleMarker,
  NativeGitBundleStateError,
  validateNativeGitBundleStateFiles
} from "./native-bundle-state-validation.js";
import { acquireStorageOwner, inspectStorageOwner, type StorageOwner } from "./storage-owner.js";

const ownerDatabaseName = ".dim-native-git-owner.sqlite3";
const databaseName = "native-idle.sqlite3";
const markerName = "state-format.json";
const activeStates = new WeakSet<NativeGitBundleState>();

export type NativeGitBundleState = {
  readonly database: string;
  readonly stateFormat: 8;
  readonly owner: StorageOwner;
};

export async function initializeNativeGitBundleState(
  stateDirectory: string,
  expectedGenerationId?: string
): Promise<NativeGitBundleState> {
  await ensureStateDirectory(stateDirectory);
  const owner = await acquireStorageOwner(stateDirectory);
  try {
    const entries = await readdir(stateDirectory);
    const database = join(stateDirectory, databaseName);
    if (entries.length === 1 && entries[0] === ownerDatabaseName) {
      const sqlite = createNativeGitBundleDatabase(database);
      sqlite.close();
      await chmod(database, 0o600);
      await syncNativeGitBundlePath(database, false);
      await syncNativeGitBundlePath(stateDirectory, true);
      await publishNativeGitBundleMarker(join(stateDirectory, markerName), expectedNativeGitBundleMarker());
      await syncNativeGitBundlePath(stateDirectory, true);
    } else {
      const persisted = await validateNativeGitBundleStateFiles(stateDirectory, entries);
      if (expectedGenerationId !== undefined && persisted.imports.some((rootImport) =>
        rootImport.generationId !== expectedGenerationId && rootImport.phase !== "root-imported")) {
        throw new NativeGitBundleStateError("native Project root import belongs to another generation");
      }
      await persisted.reconcileRootImports();
    }
    const state: NativeGitBundleState = {
      database,
      stateFormat: 8,
      owner: {
        async release() {
          if (!activeStates.delete(state)) return;
          await owner.release();
        }
      }
    };
    activeStates.add(state);
    return state;
  } catch (error) {
    await owner.release();
    throw error;
  }
}

export async function inspectNativeGitBundleState(
  stateDirectory: string
): Promise<{ readonly stateFormat: 8 }> {
  await assertDirectory(stateDirectory);
  const entries = await readdir(stateDirectory);
  await inspectStorageOwner(stateDirectory);
  await validateNativeGitBundleStateFiles(stateDirectory, entries);
  return { stateFormat: 8 };
}

export function registerNativeProject(state: NativeGitBundleState, generationId: string, input: unknown): void {
  assertNativeGitBundleStateActive(state);
  registerNativeProjectInDatabase(state.database, generationId, input);
}

export function readNativeProjectRegistrations(
  state: NativeGitBundleState
): readonly NativeProjectRegistration[] {
  assertNativeGitBundleStateActive(state);
  return readNativeProjectRegistrationsFromDatabase(state.database);
}

export function claimNativeProjectRootImport(
  state: NativeGitBundleState,
  generationId: string,
  ownerHostId: string,
  input: unknown
): NativeProjectRootImport {
  assertNativeGitBundleStateActive(state);
  return claimNativeProjectRootImportInDatabase(state.database, generationId, ownerHostId, input);
}

export function markNativeProjectRootBundleDurable(
  state: NativeGitBundleState,
  projectId: string,
  importNonce: string,
  bundleDigest: string,
  bundleSize: number
): NativeProjectRootImportDurable | NativeProjectRootImportInstalled {
  assertNativeGitBundleStateActive(state);
  return markNativeProjectRootBundleDurableInDatabase(state.database, projectId, importNonce, bundleDigest, bundleSize);
}

export function beginNativeProjectRootImportInstallation(
  state: NativeGitBundleState,
  projectId: string,
  ownerHostId: string,
  selector: NativeProjectRootImportFinalizeSelector
): NativeProjectRootImport {
  assertNativeGitBundleStateActive(state);
  return beginNativeProjectRootImportInstallationInDatabase(
    state.database, projectId, ownerHostId, selector
  );
}

export function markNativeProjectRootObjectsInstalled(
  state: NativeGitBundleState,
  projectId: string,
  selector: NativeProjectRootImportFinalizeSelector,
  resolvedTree: string
): NativeProjectRootImportInstalled {
  assertNativeGitBundleStateActive(state);
  return markNativeProjectRootObjectsInstalledInDatabase(state.database, projectId, selector, resolvedTree);
}

export function markNativeProjectRootImported(
  state: NativeGitBundleState,
  projectId: string,
  selector: NativeProjectRootImportFinalizeSelector,
  resolvedTree: string
): NativeProjectRootImportInstalled {
  assertNativeGitBundleStateActive(state);
  return markNativeProjectRootImportedInDatabase(state.database, projectId, selector, resolvedTree);
}

export { NativeProjectRegistrationConflictError };

async function ensureStateDirectory(path: string): Promise<void> {
  try {
    await assertDirectory(path);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
    await mkdir(path, { mode: 0o750 });
  }
}

async function assertDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new NativeGitBundleStateError("native Git bundle state path must be a directory");
  }
}

export function assertNativeGitBundleStateActive(state: NativeGitBundleState): void {
  if (!activeStates.has(state)) {
    throw new NativeGitBundleStateError("native Git bundle storage owner is not active");
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export { NativeGitBundleStateError } from "./native-bundle-state-validation.js";
