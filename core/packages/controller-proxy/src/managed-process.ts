import { randomUUID } from "node:crypto";
import { open, readFile, readdir, readlink, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export type ProcessIdentity = {
  readonly pid: number;
  readonly startTime: string;
};

export type ProcessIdentityStatus = "dead" | "matching" | "mismatched";

export class ProcessIdentityError extends Error {
  readonly name = "ProcessIdentityError";
}

type ProcessSnapshot = {
  readonly state: string;
  readonly startTime: string;
};

const OWNERLESS_LOCK_GRACE_MS = 100;

export async function currentProcessIdentity(): Promise<ProcessIdentity> {
  const startTime = await processStartTime(process.pid);
  if (startTime === undefined) throw new ProcessIdentityError("cannot read current process start identity");
  return { pid: process.pid, startTime };
}

export async function currentPidNamespace(): Promise<string> {
  const namespace = await readlink("/proc/self/ns/pid");
  if (!/^pid:\[\d+\]$/.test(namespace)) {
    throw new ProcessIdentityError(`invalid PID namespace identity: ${namespace}`);
  }
  return namespace;
}

export async function currentPidNamespaceStartTime(): Promise<string> {
  const startTime = await processStartTime(1);
  if (startTime === undefined) {
    throw new ProcessIdentityError("cannot read PID namespace init process identity");
  }
  return startTime;
}

export async function processIdentityStatus(
  identity: ProcessIdentity,
  commandMarker?: string
): Promise<ProcessIdentityStatus> {
  const snapshot = await processSnapshot(identity.pid);
  if (snapshot === undefined || snapshot.state === "Z") return "dead";
  if (snapshot.startTime !== identity.startTime) return "mismatched";
  if (commandMarker === undefined) return "matching";
  const commandLine = await procFile(identity.pid, "cmdline");
  if (commandLine === undefined) return "dead";
  return commandLine.toString("utf8").split("\0").includes(commandMarker)
    ? "matching"
    : "mismatched";
}

export async function processStartTime(pid: number): Promise<string | undefined> {
  return (await processSnapshot(pid))?.startTime;
}

export async function processOwnsUnixSocket(pid: number, socketPath: string): Promise<boolean> {
  const table = await readFile("/proc/net/unix", "utf8");
  const inodes = table.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    const inode = fields[6];
    return fields.length >= 8 && inode !== undefined && fields.slice(7).join(" ") === socketPath
      ? [inode]
      : [];
  });
  if (inodes.length === 0) return false;
  let descriptors: string[];
  try {
    descriptors = await readdir(`/proc/${pid}/fd`);
  } catch (error) {
    if (isMissingProcess(error)) return false;
    throw error;
  }
  const targets = await Promise.all(descriptors.map(async (descriptor) => {
    try {
      return await readlink(`/proc/${pid}/fd/${descriptor}`);
    } catch (error) {
      if (isMissingProcess(error)) return undefined;
      throw error;
    }
  }));
  return inodes.some((inode) => targets.includes(`socket:[${inode}]`));
}

export async function acquireProcessLock(
  lockPath: string,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let acquired = false;
    try {
      const lock = await open(lockPath, "wx", 0o600);
      acquired = true;
      try {
        await lock.writeFile(JSON.stringify(await currentProcessIdentity()));
      } finally {
        await lock.close();
      }
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (acquired) {
        await rm(lockPath, { force: true });
        throw error;
      }
      if (!isLockContended(error)) throw error;
    }
    const owner = await readLockOwner(lockPath);
    if (owner !== undefined && await processIdentityStatus(owner) === "dead") {
      await recoverLock(lockPath);
    } else if (owner === undefined && await lockAge(lockPath) >= OWNERLESS_LOCK_GRACE_MS) {
      await recoverLock(lockPath);
    } else {
      await delay(pollIntervalMs);
    }
  }
  throw new ProcessIdentityError(`timed out waiting for managed proxy startup lock: ${lockPath}`);
}

async function processSnapshot(pid: number): Promise<ProcessSnapshot | undefined> {
  const stat = await procFile(pid, "stat");
  if (stat === undefined) return undefined;
  const closingParenthesis = stat.lastIndexOf(41);
  if (closingParenthesis < 0) throw new ProcessIdentityError(`invalid process stat for PID ${pid}`);
  const fields = stat.subarray(closingParenthesis + 2).toString("utf8").trim().split(/\s+/);
  const state = fields[0];
  const startTime = fields[19];
  if (state === undefined || startTime === undefined || !/^\d+$/.test(startTime)) {
    throw new ProcessIdentityError(`invalid process start identity for PID ${pid}`);
  }
  return { state, startTime };
}

async function readLockOwner(lockPath: string): Promise<ProcessIdentity | undefined> {
  try {
    const lockStat = await stat(lockPath);
    const ownerPath = lockStat.isDirectory() ? path.join(lockPath, "owner.json") : lockPath;
    const value: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
    if (!isObject(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1
      || typeof value.startTime !== "string" || !/^\d+$/.test(value.startTime)) return undefined;
    return { pid: Number(value.pid), startTime: value.startTime };
  } catch (error) {
    if (error instanceof SyntaxError || isMissingProcess(error)) return undefined;
    throw error;
  }
}

async function recoverLock(lockPath: string): Promise<void> {
  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
    await rm(stalePath, { recursive: true, force: true });
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

async function lockAge(lockPath: string): Promise<number> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if (isMissingProcess(error)) return 0;
    throw error;
  }
}

async function procFile(pid: number, name: "cmdline" | "stat"): Promise<Buffer | undefined> {
  try {
    return await readFile(`/proc/${pid}/${name}`);
  } catch (error) {
    if (isMissingProcess(error)) return undefined;
    throw error;
  }
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ESRCH");
}

function isLockContended(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
