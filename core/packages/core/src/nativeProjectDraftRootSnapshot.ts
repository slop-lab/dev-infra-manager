import { chmod, lstat, mkdir, mkdtemp, open, readlink, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.js";
import { effectiveUserId } from "./nativeGitCandidateProcess.js";
import { materializeNativeRootSnapshotTree } from "./nativeGitRootSnapshotTree.js";
import { assertNativeProjectRootSnapshotTree } from "./nativeProjectRootSnapshotTreeHash.js";
import {
  issueNativeProjectDraftRootReadLease,
  type NativeProjectDraftRootReadInput,
  validateNativeProjectDraftRootRead
} from "./nativeProjectDraftRootRead.js";
import { LifecycleState } from "./lifecycleState.js";

const reservedLinks = new Set([
  ".dim", ".dim/setup.sh", ".dim/entrypoint.sh", ".dim/teardown.sh", ".dim/docker-compose.yml"
]);

export type NativeProjectDraftRootSnapshotInput = NativeProjectDraftRootReadInput & {
  readonly gitExecutable: string;
  readonly temporaryRoot: string;
};

export type NativeProjectDraftRootSnapshot = {
  readonly projectId: string;
  readonly rootRepositoryId: "root";
  readonly rootAlias: string;
  readonly protectedRef: string;
  readonly rootCommit: string;
  readonly rootTree: string;
  readonly rootSnapshotPath: string;
};

export class NativeProjectDraftRootSnapshotError extends UserError {
  readonly name = "NativeProjectDraftRootSnapshotError";
}

export async function materializeNativeProjectDraftRootSnapshot(
  input: NativeProjectDraftRootSnapshotInput
): Promise<NativeProjectDraftRootSnapshot> {
  const state = new LifecycleState(input.stateRoot);
  const release = await state.acquireProjectLock(input.name);
  let staging: string | undefined;
  try {
    const validated = await validateNativeProjectDraftRootRead(input);
    const draft = validated.draft;
    const parent = path.join(input.stateRoot, "assets", "native-project-roots", draft.projectId);
    await ensurePrivateParents(input.stateRoot, draft.projectId);
    const target = path.join(parent, draft.expectedCommit);
    if (await validateCachedSnapshot(target, draft.expectedTree)) return descriptor(draft, target);

    const lease = await issueNativeProjectDraftRootReadLease(input);
    staging = await mkdtemp(path.join(parent, ".staging-"));
    await materializeNativeRootSnapshotTree({ gitExecutable: input.gitExecutable,
       temporaryRoot: input.temporaryRoot, serviceEndpoint: validated.serviceEndpoint,
       projectId: draft.projectId, protectedRef: draft.protectedRef,
       currentHeadCommit: validated.currentHeadCommit,
       commit: draft.expectedCommit, tree: draft.expectedTree,
      username: lease.username, password: lease.password, destination: staging, signal: input.signal });
    await makeSnapshotReadOnly(staging);
    await assertSnapshot(staging);
    await assertAbsent(target);
    await rename(staging, target);
    staging = undefined;
    await syncDirectory(parent);
    return descriptor(draft, target);
  } catch (error) {
    if (error instanceof NativeProjectDraftRootSnapshotError) throw error;
    throw new NativeProjectDraftRootSnapshotError("native Project draft root snapshot could not be materialized");
  } finally {
    if (staging !== undefined) await removePrivateStaging(staging);
    await release();
  }
}

function descriptor(draft: {
  readonly projectId: string;
  readonly rootRepositoryId: "root";
  readonly rootAlias: string;
  readonly protectedRef: string;
  readonly expectedCommit: string;
  readonly expectedTree: string;
}, rootSnapshotPath: string): NativeProjectDraftRootSnapshot {
  return { projectId: draft.projectId, rootRepositoryId: draft.rootRepositoryId,
    rootAlias: draft.rootAlias, protectedRef: draft.protectedRef,
    rootCommit: draft.expectedCommit, rootTree: draft.expectedTree, rootSnapshotPath };
}

async function ensurePrivateParents(stateRoot: string, projectId: string): Promise<void> {
  const components = ["assets", "native-project-roots", projectId];
  let current = stateRoot;
  for (const component of components) {
    current = path.join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
      await chmod(current, 0o700);
      await syncDirectory(path.dirname(current));
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== effectiveUserId()
      || (metadata.mode & 0o777) !== 0o700 || await realpath(current) !== current) {
      throw new NativeProjectDraftRootSnapshotError("native root snapshot parent is not private and canonical");
    }
  }
}

async function validateCachedSnapshot(target: string, expectedTree: string): Promise<boolean> {
  try {
    await lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  await assertSnapshot(target);
  await assertNativeProjectRootSnapshotTree(target, expectedTree);
  return true;
}

async function assertSnapshot(root: string): Promise<void> {
  const owner = effectiveUserId();
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
    || rootMetadata.uid !== owner || (rootMetadata.mode & 0o777) !== 0o555) invalidCache();
  await walk(root, async (entry, relativePath) => {
    const metadata = await lstat(entry);
    if (metadata.uid !== owner) invalidCache();
    if (metadata.isDirectory()) {
      if ((metadata.mode & 0o777) !== 0o555 || metadata.nlink < 2) invalidCache();
      return;
    }
    if (metadata.isFile()) {
      const mode = metadata.mode & 0o777;
      if ((mode !== 0o444 && mode !== 0o555) || metadata.nlink !== 1) invalidCache();
      return;
    }
    if (!metadata.isSymbolicLink() || metadata.nlink !== 1 || reservedLinks.has(relativePath)) invalidCache();
    const link = await readlink(entry);
    if (path.isAbsolute(link)) invalidCache();
    let resolved: string;
    try {
      resolved = await realpath(entry);
    } catch (error) {
      if (error instanceof Error) invalidCache();
      throw error;
    }
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) invalidCache();
  });
}

async function makeSnapshotReadOnly(root: string): Promise<void> {
  await walk(root, async (entry) => {
    const metadata = await lstat(entry);
    if (metadata.isFile()) await chmod(entry, metadata.mode & 0o111 ? 0o555 : 0o444);
  });
  await makeDirectoriesReadOnly(root);
}

async function makeDirectoriesReadOnly(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeDirectoriesReadOnly(path.join(root, entry.name));
  }
  await chmod(root, 0o555);
}

async function removePrivateStaging(root: string): Promise<void> {
  try {
    await makeDirectoriesWritable(root);
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function makeDirectoriesWritable(root: string): Promise<void> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory()) return;
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeDirectoriesWritable(path.join(root, entry.name));
  }
}

async function walk(root: string, visit: (entry: string, relativePath: string) => Promise<void>,
  current = root): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    await visit(target, path.relative(root, target));
    if (entry.isDirectory()) await walk(root, visit, target);
  }
}

async function assertAbsent(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  throw new NativeProjectDraftRootSnapshotError("native root snapshot target already exists");
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function invalidCache(): never {
  throw new NativeProjectDraftRootSnapshotError("native root snapshot cache is unsafe");
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
