import type { BigIntStats } from "node:fs";
import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { NativeProjectRegistration } from "./native-project-registry-state.js";
import type { NativeProjectRootImport } from "./native-project-root-import-state.js";
import { assertOwnedNativeProjectStorage } from "./native-project-storage.js";
import {
  assertPrivateDirectory,
  rootBundleDirectory,
  syncDirectory
} from "./native-root-import-storage.js";

const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const uploadName = new RegExp(`^\\.${uuidV4}\\.upload$`);
const verificationName = new RegExp(`^\\.verify-${uuidV4}$`);
const maximumBundleBytes = 256 * 1024 * 1024;
const directoryModes = new Set([0o700n, 0o755n]);
const fileModes = new Set([0o400n, 0o444n, 0o600n, 0o644n, 0o700n, 0o755n]);

type Identity = Pick<BigIntStats, "dev" | "ino" | "mode" | "uid" | "nlink" | "size">;
type ValidatedFile = { readonly path: string; readonly identity: Identity };
type ValidatedDirectory = { readonly path: string; readonly identity: Identity };
type ValidatedTree = {
  readonly files: readonly ValidatedFile[];
  readonly directories: readonly ValidatedFile[];
};
type Cleanup =
  | { readonly kind: "file"; readonly file: ValidatedFile; readonly parents: readonly ValidatedDirectory[] }
  | { readonly kind: "tree"; readonly tree: ValidatedTree; readonly parents: readonly ValidatedDirectory[] };

export type NativeRootImportReconciliation = () => Promise<void>;

export async function inspectNativeRootImportStaging(
  stateDirectory: string,
  registrations: readonly NativeProjectRegistration[],
  imports: readonly NativeProjectRootImport[]
): Promise<NativeRootImportReconciliation> {
  const importsByProject = new Map(imports.map((entry) => [entry.projectId, entry]));
  const cleanup: Cleanup[] = [];
  for (const registration of registrations) {
    if (registration.phase !== "root-prepared") continue;
    const projectRoot = join(stateDirectory, registration.projectId);
    const directory = rootBundleDirectory(stateDirectory, registration.projectId);
    if (!await exists(directory)) continue;
    await assertOwnedNativeProjectStorage(stateDirectory, registration);
    await assertPrivateDirectory(directory);
    const parents = [await validatePrivateDirectory(projectRoot), await validatePrivateDirectory(directory)];
    const rootImport = importsByProject.get(registration.projectId);
    if (rootImport === undefined) {
      throw new NativeRootImportReconciliationError("root import staging directory has no bound intent");
    }
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      if (name === `${rootImport.importNonce}.bundle`) {
        const file = await validateBundleFile(path, rootImport.phase === "intent");
        if (rootImport.phase === "intent") cleanup.push({ kind: "file", file, parents });
      } else if (uploadName.test(name)) {
        cleanup.push({ kind: "file", file: await validateUpload(path), parents });
      } else if (verificationName.test(name)) {
        cleanup.push({ kind: "tree", tree: await validateVerificationTree(path), parents });
      } else {
        throw new NativeRootImportReconciliationError(`unknown root import staging artifact '${name}'`);
      }
    }
  }
  return async () => {
    const changed = new Map<string, readonly ValidatedDirectory[]>();
    for (const action of cleanup) {
      for (const parent of action.parents) await assertDirectoryIdentity(parent);
      if (action.kind === "file") {
        await removeFile(action.file);
      } else {
        await removeTree(action.tree);
      }
      const staging = action.parents.at(-1);
      if (staging !== undefined) changed.set(staging.path, action.parents);
    }
    for (const [path, parents] of changed) {
      for (const parent of parents) await assertDirectoryIdentity(parent);
      await syncDirectory(path);
    }
  };
}

async function validatePrivateDirectory(path: string): Promise<ValidatedDirectory> {
  const identity = await lstat(path, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink() || !isServiceOwned(identity)
    || (identity.mode & 0o777n) !== 0o700n) {
    throw new NativeRootImportReconciliationError("root import private directory is unsafe");
  }
  return { path, identity };
}

async function validateUpload(path: string): Promise<ValidatedFile> {
  const identity = await lstat(path, { bigint: true });
  if (!identity.isFile() || identity.isSymbolicLink() || !isServiceOwned(identity)
    || (identity.mode & 0o777n) !== 0o600n || identity.nlink !== 1n
    || identity.size > BigInt(maximumBundleBytes)) {
    throw new NativeRootImportReconciliationError("root import upload staging artifact is unsafe");
  }
  return { path, identity };
}

async function validateBundleFile(path: string, removable: boolean): Promise<ValidatedFile> {
  const file = await validateUpload(path);
  if (removable && file.identity.size === 0n) {
    throw new NativeRootImportReconciliationError("root import final staging artifact is unsafe");
  }
  return file;
}

async function validateVerificationTree(root: string): Promise<ValidatedTree> {
  const files: ValidatedFile[] = [];
  const directories: ValidatedFile[] = [];
  async function visit(path: string, rootEntry: boolean): Promise<void> {
    const identity = await lstat(path, { bigint: true });
    const mode = identity.mode & 0o777n;
    if (!isServiceOwned(identity) || identity.isSymbolicLink()) {
      throw new NativeRootImportReconciliationError("root import verification artifact is unsafe");
    }
    if (identity.isDirectory()) {
      if ((rootEntry && mode !== 0o700n) || (!rootEntry && !directoryModes.has(mode))) {
        throw new NativeRootImportReconciliationError("root import verification directory mode is unsafe");
      }
      directories.push({ path, identity });
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), false);
      return;
    }
    if (!identity.isFile() || identity.nlink !== 1n || !fileModes.has(mode)) {
      throw new NativeRootImportReconciliationError("root import verification file is unsafe");
    }
    files.push({ path, identity });
  }
  await visit(root, true);
  return { files, directories: directories.reverse() };
}

async function removeFile(file: ValidatedFile): Promise<void> {
  assertSameIdentity(file.identity, await lstat(file.path, { bigint: true }));
  await unlink(file.path);
}

async function removeTree(tree: ValidatedTree): Promise<void> {
  for (const file of tree.files) await removeFile(file);
  for (const directory of tree.directories) {
    const current = await lstat(directory.path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== directory.identity.dev || current.ino !== directory.identity.ino
      || current.uid !== directory.identity.uid || current.mode !== directory.identity.mode) {
      throw new NativeRootImportReconciliationError("root import verification directory changed during cleanup");
    }
    await rmdir(directory.path);
  }
}

async function assertDirectoryIdentity(directory: ValidatedDirectory): Promise<void> {
  const current = await lstat(directory.path, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink()
    || current.dev !== directory.identity.dev || current.ino !== directory.identity.ino
    || current.uid !== directory.identity.uid || current.mode !== directory.identity.mode) {
    throw new NativeRootImportReconciliationError("root import private directory changed during cleanup");
  }
}

function assertSameIdentity(expected: Identity, actual: BigIntStats): void {
  if (!actual.isFile() || actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino
    || actual.mode !== expected.mode || actual.uid !== expected.uid || actual.nlink !== expected.nlink
    || actual.size !== expected.size) {
    throw new NativeRootImportReconciliationError("root import staging artifact changed during cleanup");
  }
}

function isServiceOwned(identity: BigIntStats): boolean {
  const owner = process.geteuid?.();
  return owner !== undefined && identity.uid === BigInt(owner);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export class NativeRootImportReconciliationError extends Error {
  readonly name = "NativeRootImportReconciliationError";
}
