import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const LOCK_WAIT_MILLISECONDS = 20_000;
const INCOMPLETE_LOCK_GRACE_MILLISECONDS = 1_000;

type ProcessIdentity = {
  readonly pid: number;
  readonly startTime: string;
};

export async function withDevelopmentServiceLock<T>(
  controlSocket: string,
  serviceName: string,
  operation: () => Promise<T>
): Promise<T> {
  const lockDirectory = path.join(path.dirname(controlSocket), `.expose-${serviceName}.lock`);
  const identity = await currentIdentity();
  const deadline = Date.now() + LOCK_WAIT_MILLISECONDS;
  while (!await tryAcquire(lockDirectory, identity)) {
    if (Date.now() >= deadline) {
      throw new DevelopmentServiceLockError(`timed out waiting to expose service '${serviceName}'`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    return await operation();
  } finally {
    await releaseOwnedLock(lockDirectory, identity);
  }
}

async function tryAcquire(lockDirectory: string, identity: ProcessIdentity): Promise<boolean> {
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(path.join(lockDirectory, "owner.json"), `${JSON.stringify(identity)}\n`, {
      mode: 0o600,
      flag: "wx"
    });
    return true;
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  if (await lockOwnerIsActive(lockDirectory)) return false;
  await rm(lockDirectory, { recursive: true });
  return false;
}

async function lockOwnerIsActive(lockDirectory: string): Promise<boolean> {
  const metadata = await lstat(lockDirectory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new DevelopmentServiceLockError(`development service lock path is unsafe: ${lockDirectory}`);
  }
  try {
    return await processMatches(await readLockIdentity(lockDirectory));
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")
      && !(error instanceof SyntaxError)
      && !(error instanceof DevelopmentServiceLockError)) throw error;
    return Date.now() - metadata.mtimeMs < INCOMPLETE_LOCK_GRACE_MILLISECONDS;
  }
}

async function releaseOwnedLock(lockDirectory: string, expected: ProcessIdentity): Promise<void> {
  try {
    const current = await readLockIdentity(lockDirectory);
    if (current.pid === expected.pid && current.startTime === expected.startTime) {
      await rm(lockDirectory, { recursive: true });
    }
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function readLockIdentity(lockDirectory: string): Promise<ProcessIdentity> {
  const ownerPath = path.join(lockDirectory, "owner.json");
  const metadata = await lstat(ownerPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new DevelopmentServiceLockError(`development service lock owner is unsafe: ${ownerPath}`);
  }
  const parsed: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
  return parseIdentity(parsed);
}

async function currentIdentity(): Promise<ProcessIdentity> {
  return { pid: process.pid, startTime: await linuxProcessStartTime(process.pid) };
}

async function processMatches(identity: ProcessIdentity): Promise<boolean> {
  try {
    return await linuxProcessStartTime(identity.pid) === identity.startTime;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function linuxProcessStartTime(pid: number): Promise<string> {
  const processStat = await readFile(`/proc/${pid}/stat`, "utf8");
  const closingParenthesis = processStat.lastIndexOf(")");
  const fields = processStat.slice(closingParenthesis + 2).trim().split(/\s+/);
  const startTime = fields[19];
  if (closingParenthesis < 0 || startTime === undefined) {
    throw new DevelopmentServiceLockError(`could not read process identity for PID ${pid}`);
  }
  return startTime;
}

function parseIdentity(value: unknown): ProcessIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !("pid" in value) || !("startTime" in value)
    || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid < 1
    || typeof value.startTime !== "string" || !/^\d+$/.test(value.startTime)) {
    throw new DevelopmentServiceLockError("development service lock identity is invalid");
  }
  return { pid: value.pid, startTime: value.startTime };
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class DevelopmentServiceLockError extends Error {
  readonly name = "DevelopmentServiceLockError";
}
