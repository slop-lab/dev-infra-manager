import { spawn } from "node:child_process";
import { constants, fstatSync, lstatSync, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { assertStateDirectory, ensureStateDirectory, errorCode, syncStateDirectory } from "./controlPlaneStateFs.js";

const inheritedLockDescriptor = 3;
const lockBrand: unique symbol = Symbol("ControlPlaneStateLock");
const liveLocks = new WeakMap<object, LockDescriptor>();

type LockIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
};

type LockDescriptor = LockIdentity & {
  readonly fd: number;
  readonly path: string;
};

export type ControlPlaneStateLock = {
  readonly [lockBrand]: true;
  readonly root: string;
  readonly owner: { readonly schemaVersion: 1; readonly pid: number; readonly uid: number; readonly startedAt: string };
  close(): Promise<void>;
};

export async function acquireControlPlaneStateLock(root: string): Promise<ControlPlaneStateLock> {
  await ensureStateDirectory(root);
  const path = join(root, "install.lock");
  const handle = await openLockFile(path, root);
  try {
    const identity = await lockIdentity(handle, path, root);
    await acquireKernelLock(handle.fd);
    await assertLockIdentity(handle, path, root, identity);
    const owner: ControlPlaneStateLock["owner"] = {
      schemaVersion: 1,
      pid: process.pid,
      uid: currentUid(),
      startedAt: new Date().toISOString()
    };
    await writeOwner(handle, owner);
    await assertLockIdentity(handle, path, root, identity);
    await assertOwner(handle, owner);

    let closed = false;
    const lock: ControlPlaneStateLock = {
      [lockBrand]: true,
      root,
      owner,
      async close() {
        if (closed) return;
        closed = true;
        liveLocks.delete(lock);
        await handle.close();
      }
    };
    liveLocks.set(lock, { fd: handle.fd, path, ...identity });
    return lock;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function assertControlPlaneStateLock(lock: ControlPlaneStateLock, root?: string): void {
  const descriptor = liveLocks.get(lock);
  if (descriptor === undefined || (root !== undefined && lock.root !== root)) throw lockNotHeld();
  try {
    const opened = fstatSync(descriptor.fd, { bigint: true });
    const named = lstatSync(descriptor.path, { bigint: true });
    assertLockMetadata(opened);
    assertLockMetadata(named);
    if (!sameIdentity(opened, descriptor) || !sameIdentity(named, descriptor)) throw lockNotHeld();
  } catch (error) {
    liveLocks.delete(lock);
    if (error instanceof ControlPlaneLockError) throw error;
    throw lockNotHeld(error);
  }
}

async function openLockFile(path: string, root: string): Promise<FileHandle> {
  let handle: FileHandle;
  let created = false;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  }
  try {
    if (created) {
      await handle.sync();
      await syncStateDirectory(root);
    }
    await lockIdentity(handle, path, root);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function lockIdentity(handle: FileHandle, path: string, root: string): Promise<LockIdentity> {
  const opened = await handle.stat({ bigint: true });
  const named = await lstat(path, { bigint: true });
  assertLockMetadata(opened);
  assertLockMetadata(named);
  if (!sameIdentity(opened, named)) throw new ControlPlaneLockError("control-plane install lock pathname changed while opened");
  await assertStateDirectory(root);
  return { dev: opened.dev, ino: opened.ino };
}

async function assertLockIdentity(handle: FileHandle, path: string, root: string, identity: LockIdentity): Promise<void> {
  const opened = await handle.stat({ bigint: true });
  const named = await lstat(path, { bigint: true });
  assertLockMetadata(opened);
  assertLockMetadata(named);
  if (!sameIdentity(opened, identity) || !sameIdentity(named, identity)) {
    throw new ControlPlaneLockError("control-plane install lock pathname changed while held");
  }
  await assertStateDirectory(root);
}

function assertLockMetadata(metadata: BigIntStats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== BigInt(currentUid())
    || Number(metadata.mode & 0o777n) !== 0o600 || metadata.nlink !== 1n) {
    throw new ControlPlaneLockError("control-plane install lock must be a caller-owned mode-0600 regular file");
  }
}

function sameIdentity(left: Pick<BigIntStats, "dev" | "ino">, right: LockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function acquireKernelLock(fd: number): Promise<void> {
  const child = spawn(
    "/usr/bin/flock",
    ["--exclusive", "--nonblock", "--conflict-exit-code", "73", String(inheritedLockDescriptor)],
    { stdio: ["ignore", "ignore", "ignore", fd] as const }
  );
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else if (code === 73) reject(new ControlPlaneLockError("control-plane state is locked by another installer"));
      else reject(new ControlPlaneLockError(`control-plane lock helper failed with ${code ?? signal}`));
    });
  });
}

async function writeOwner(handle: FileHandle, owner: ControlPlaneStateLock["owner"]): Promise<void> {
  await handle.truncate(0);
  await handle.writeFile(`${JSON.stringify(owner)}\n`);
  await handle.sync();
}

async function assertOwner(handle: FileHandle, expected: ControlPlaneStateLock["owner"]): Promise<void> {
  const metadata = await handle.stat({ bigint: true });
  if (metadata.size > 4096n) throw new ControlPlaneLockError("control-plane lock owner record is malformed");
  const bytes = Buffer.alloc(Number(metadata.size));
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
  if (bytesRead !== bytes.length) throw new ControlPlaneLockError("control-plane lock owner record changed while read");
  const actual = parseOwner(bytes.toString("utf8"));
  if (actual.schemaVersion !== expected.schemaVersion || actual.pid !== expected.pid
    || actual.uid !== expected.uid || actual.startedAt !== expected.startedAt) {
    throw new ControlPlaneLockError("control-plane lock owner record changed while held");
  }
}

function parseOwner(text: string): ControlPlaneStateLock["owner"] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ControlPlaneLockError("control-plane lock owner record is malformed", { cause: error });
    throw error;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== 4 || Reflect.get(value, "schemaVersion") !== 1
    || typeof Reflect.get(value, "pid") !== "number" || typeof Reflect.get(value, "uid") !== "number"
    || typeof Reflect.get(value, "startedAt") !== "string") {
    throw new ControlPlaneLockError("control-plane lock owner record is malformed");
  }
  return {
    schemaVersion: 1,
    pid: Reflect.get(value, "pid"),
    uid: Reflect.get(value, "uid"),
    startedAt: Reflect.get(value, "startedAt")
  };
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ControlPlaneLockError("control-plane state lock requires a Linux user identity");
  return uid;
}

function lockNotHeld(cause?: unknown): ControlPlaneLockError {
  return new ControlPlaneLockError("control-plane state lock is not held for this state root", cause === undefined ? undefined : { cause });
}

export class ControlPlaneLockError extends Error {
  readonly name = "ControlPlaneLockError";
}
