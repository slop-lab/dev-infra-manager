import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { UserError } from "./errors.js";

export type OpenedStateFile = {
  readonly handle: FileHandle;
  readonly metadata: BigIntStats;
};

export async function assertOrdinaryStateDirectory(path: string): Promise<void> {
  const opened = await openOrdinaryStateDirectory(path);
  await opened.handle.close();
}

export async function openOrdinaryStateDirectory(path: string): Promise<OpenedStateFile> {
  const metadata = await lstat(path, { bigint: true });
  assertDirectoryMetadata(metadata);
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertDirectoryMetadata(opened);
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new UserError("ordinary CI bundle state directory changed while it was opened");
    }
    return { handle, metadata: opened };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function openOrdinaryStateFile(
  path: string,
  mode: 0o444 | 0o600,
  label: string
): Promise<OpenedStateFile> {
  const before = await lstat(path, { bigint: true });
  assertRegularMetadata(before, mode, label);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertRegularMetadata(opened, mode, label);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new UserError(`${label} changed while it was opened`);
    }
    return { handle, metadata: opened };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function assertOrdinaryStateFile(path: string, mode: 0o444 | 0o600, label: string): Promise<void> {
  const opened = await openOrdinaryStateFile(path, mode, label);
  await opened.handle.close();
}

export async function setPrivateFileMode(path: string): Promise<void> {
  await chmod(path, 0o600);
}

export function metadataChanged(
  before: BigIntStats,
  after: BigIntStats
): boolean {
  return before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || before.mode !== after.mode || before.uid !== after.uid || before.nlink !== after.nlink;
}

function assertDirectoryMetadata(metadata: BigIntStats): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new UserError("ordinary CI bundle state path must be a directory, not a symlink or special file");
  }
  assertOwner(metadata.uid, "ordinary CI bundle state directory");
  assertMode(metadata.mode, 0o750, "ordinary CI bundle state directory");
  if (metadata.nlink !== 2n) throw new UserError("ordinary CI bundle state directory must have exactly two links");
}

function assertRegularMetadata(
  metadata: BigIntStats,
  mode: 0o444 | 0o600,
  label: string
): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new UserError(`${label} must be a regular file`);
  assertOwner(metadata.uid, label);
  assertMode(metadata.mode, mode, label);
  if (metadata.nlink !== 1n) throw new UserError(`${label} must have exactly one link`);
}

function assertOwner(uid: bigint, label: string): void {
  const serviceUid = process.geteuid?.();
  if (serviceUid === undefined || uid !== BigInt(serviceUid)) {
    throw new UserError(`${label} must be owned by the ordinary CI service user`);
  }
}

function assertMode(actual: bigint, expected: number, label: string): void {
  if (Number(actual & 0o777n) !== expected) {
    throw new UserError(`${label} must have mode ${expected.toString(8).padStart(4, "0")}`);
  }
}
