import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rm, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { hasDuplicateJsonKeys } from "./nativeControlPlaneJson.js";
import { NativeProjectPendingRecordError,
  parseNativeProjectPendingRecord, type NativeProjectPendingRecord } from "./nativeProjectPendingCodec.js";

const maximumRecordBytes = 1024 * 1024;

export class NativeProjectPendingFileError extends Error {
  readonly name = "NativeProjectPendingFileError";
}

export type StoredNativeProjectPending = {
  readonly record: NativeProjectPendingRecord;
  readonly bytes: Buffer;
};

export async function readNativeProjectPending(
  stateRoot: string,
  path: string
): Promise<StoredNativeProjectPending | undefined> {
  await assertPrivateDirectory(stateRoot, "lifecycle state root");
  const directory = dirname(path);
  if (!await pathExists(directory)) return undefined;
  await assertPrivateDirectory(directory, "Project state directory");
  await assertNoStaging(directory, basename(path));
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new NativeProjectPendingFileError("canonical Project record cannot be opened safely", { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertPrivateFile(before);
    const bytes = await readExact(handle, Number(before.size));
    await assertStablePath(path, before, await handle.stat({ bigint: true }));
    let input: unknown;
    try {
      const text = bytes.toString("utf8");
      if (hasDuplicateJsonKeys(text)) throw new SyntaxError("duplicate JSON object key");
      input = JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new NativeProjectPendingFileError("canonical Project record is not valid JSON", { cause: error });
      }
      throw error;
    }
    try {
      return { record: parseNativeProjectPendingRecord(input), bytes };
    } catch (error) {
      if (error instanceof NativeProjectPendingRecordError) {
        throw new NativeProjectPendingFileError("canonical Project record is not native admission-pending state", {
          cause: error
        });
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}

export async function recoverNativeProjectPendingPublication(
  stateRoot: string,
  path: string,
  expectedBytes: Buffer
): Promise<void> {
  await assertPrivateDirectory(stateRoot, "lifecycle state root");
  const directory = dirname(path);
  if (!await pathExists(directory)) return;
  await assertPrivateDirectory(directory, "Project state directory");
  const staging = await stagingNames(directory, basename(path));
  if (staging.length === 0) return;
  const stagingName = staging[0];
  if (staging.length !== 1 || stagingName === undefined
    || !/^\.[^.].*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(stagingName)) {
    throw new NativeProjectPendingFileError("incomplete canonical Project staging exists");
  }
  const stagingPath = `${directory}/${stagingName}`;
  let targetHandle;
  let stagingHandle;
  try {
    targetHandle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    stagingHandle = await open(stagingPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    await Promise.all([targetHandle?.close(), stagingHandle?.close()]);
    throw new NativeProjectPendingFileError("incomplete canonical Project staging cannot be recovered safely", {
      cause: error
    });
  }
  try {
    const targetBefore = await targetHandle.stat({ bigint: true });
    const stagingBefore = await stagingHandle.stat({ bigint: true });
    assertRecoveryFile(targetBefore, expectedBytes.length);
    assertRecoveryFile(stagingBefore, expectedBytes.length);
    if (targetBefore.dev !== stagingBefore.dev || targetBefore.ino !== stagingBefore.ino) {
      throw new NativeProjectPendingFileError("canonical Project staging does not match its published record");
    }
    const actualBytes = await readExact(targetHandle, expectedBytes.length);
    if (!actualBytes.equals(expectedBytes)) {
      throw new NativeProjectPendingFileError("canonical Project staging conflicts with admission intent");
    }
    await assertStablePath(path, targetBefore, await targetHandle.stat({ bigint: true }));
    await assertStablePath(stagingPath, stagingBefore, await stagingHandle.stat({ bigint: true }));
    await syncDirectory(directory);
    await unlink(stagingPath);
    await syncDirectory(directory);
  } finally {
    await Promise.all([targetHandle.close(), stagingHandle.close()]);
  }
}

export async function publishNativeProjectPending(
  stateRoot: string,
  path: string,
  bytes: Buffer,
  syncPublishedDirectory: (directory: string) => Promise<void> = syncDirectory
): Promise<void> {
  await assertPrivateDirectory(stateRoot, "lifecycle state root");
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  await assertNoStaging(directory, basename(path));
  const temporary = `${directory}/.${basename(path)}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true });
    throw new NativeProjectPendingFileError("canonical Project staging cannot be written", { cause: error });
  } finally {
    await handle?.close();
  }
  let linked = false;
  try {
    await link(temporary, path);
    linked = true;
    await syncPublishedDirectory(directory);
    await unlink(temporary);
    await syncPublishedDirectory(directory);
  } catch (error) {
    if (!linked) await rm(temporary, { force: true });
    throw new NativeProjectPendingFileError("canonical Project record cannot be published exclusively", {
      cause: error
    });
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
    await syncDirectory(dirname(path));
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw new NativeProjectPendingFileError("Project state directory cannot be created", { cause: error });
    }
  }
  await assertPrivateDirectory(path, "Project state directory");
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new NativeProjectPendingFileError(`${label} is missing or inaccessible`, { cause: error });
  }
  const owner = process.geteuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || owner === undefined
    || metadata.uid !== owner || (metadata.mode & 0o777) !== 0o700) {
    throw new NativeProjectPendingFileError(`${label} is not private and owner-only`);
  }
}

async function assertNoStaging(directory: string, targetName: string): Promise<void> {
  if ((await stagingNames(directory, targetName)).length !== 0) {
    throw new NativeProjectPendingFileError("incomplete canonical Project staging exists");
  }
}

async function stagingNames(directory: string, targetName: string): Promise<readonly string[]> {
  const prefix = `.${targetName}.`;
  return (await readdir(directory)).filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"));
}

function assertPrivateFile(metadata: BigIntStats): void {
  const owner = process.geteuid?.();
  if (!metadata.isFile() || owner === undefined || metadata.uid !== BigInt(owner)
    || (metadata.mode & 0o777n) !== 0o600n || metadata.nlink !== 1n
    || metadata.size < 1n || metadata.size > BigInt(maximumRecordBytes)) {
    throw new NativeProjectPendingFileError("canonical Project record is not a bounded private single-link file");
  }
}

function assertRecoveryFile(metadata: BigIntStats, expectedSize: number): void {
  const owner = process.geteuid?.();
  if (!metadata.isFile() || owner === undefined || metadata.uid !== BigInt(owner)
    || (metadata.mode & 0o777n) !== 0o600n || metadata.nlink !== 2n
    || metadata.size !== BigInt(expectedSize) || metadata.size < 1n
    || metadata.size > BigInt(maximumRecordBytes)) {
    throw new NativeProjectPendingFileError("canonical Project staging is not a bounded private two-link file");
  }
}

async function readExact(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let position = 0;
  while (position < bytes.length) {
    const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
    if (bytesRead === 0) throw new NativeProjectPendingFileError("canonical Project record is truncated");
    position += bytesRead;
  }
  return bytes;
}

async function assertStablePath(path: string, before: BigIntStats, after: BigIntStats): Promise<void> {
  let current;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    throw new NativeProjectPendingFileError("canonical Project record changed during inspection", { cause: error });
  }
  if (!sameFile(before, after) || !sameFile(before, current)) {
    throw new NativeProjectPendingFileError("canonical Project record changed during inspection");
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw new NativeProjectPendingFileError("Project state directory cannot be inspected", { cause: error });
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
