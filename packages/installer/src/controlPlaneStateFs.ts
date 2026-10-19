import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureStateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ControlPlaneStateFilesystemError(`cannot create control-plane state directory ${path}`, { cause: error });
  }
  await assertStateDirectory(path);
}

export async function assertStateDirectory(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new ControlPlaneStateFilesystemError(`cannot inspect control-plane state directory ${path}`, { cause: error });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== currentUid() || (metadata.mode & 0o777) !== 0o700) {
    throw new ControlPlaneStateFilesystemError(`control-plane state directory ${path} must be caller-owned mode 0700`);
  }
}

export async function readStateFile(path: string, mode: 0o444 | 0o600, maximumBytes: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new ControlPlaneStateFilesystemError(`cannot open control-plane state file ${path}`, { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertFileMetadata(before, path, mode, maximumBytes);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertFileMetadata(after, path, mode, maximumBytes);
    if (changed(before, after) || BigInt(bytes.length) !== after.size) {
      throw new ControlPlaneStateFilesystemError(`control-plane state file ${path} changed while read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function writeExclusiveStateFile(path: string, bytes: Buffer, mode: 0o444 | 0o600): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
}

export async function replaceStateFile(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeExclusiveStateFile(temporary, bytes, 0o600);
    await rename(temporary, path);
    await syncStateDirectory(dirname(path));
  } catch (error) {
    let cleanupError: unknown;
    try {
      await rm(temporary, { force: true });
    } catch (failure) {
      cleanupError = failure;
    }
    throw new ControlPlaneStateFilesystemError("cannot replace control-plane state file", {
      cause: cleanupError === undefined ? error : new AggregateError([error, cleanupError])
    });
  }
}

export async function removeStateFile(path: string): Promise<void> {
  await unlink(path);
  await syncStateDirectory(dirname(path));
}

export async function syncStateDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function assertFileMetadata(metadata: BigIntStats, path: string, mode: number, maximumBytes: number): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== BigInt(currentUid())
    || Number(metadata.mode & 0o777n) !== mode || metadata.nlink !== 1n || metadata.size > BigInt(maximumBytes)) {
    throw new ControlPlaneStateFilesystemError(`control-plane state file ${path} has invalid ownership, mode, type, links, or size`);
  }
}

function changed(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || before.mode !== after.mode || before.uid !== after.uid || before.nlink !== after.nlink;
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ControlPlaneStateFilesystemError("control-plane state requires a Linux user identity");
  return uid;
}

export class ControlPlaneStateFilesystemError extends Error {
  readonly name = "ControlPlaneStateFilesystemError";
}
