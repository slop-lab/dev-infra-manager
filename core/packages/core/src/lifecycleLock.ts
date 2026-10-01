import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.js";
import { type KernelGuard, tryAcquireKernelGuard } from "./lifecycleLockGuard.js";

const LOCK_OWNER_VERSION = 1;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 100;
const CANONICAL_LOWERCASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type LifecycleLockOwner = {
  readonly version: 1;
  readonly pid: number;
  readonly bootId: string;
  readonly processStartTicks: string;
  readonly acquiredAt: string;
  readonly nonce: string;
};

export type ProcessProbeResult = "live" | "dead" | "reused" | "unknown";

export type LifecycleLockOptions = {
  readonly waitTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly probeProcess?: (owner: LifecycleLockOwner) => Promise<ProcessProbeResult>;
};

export type LifecycleLockRequest = {
  readonly root: string;
  readonly name: string;
  readonly description: string;
  readonly options?: LifecycleLockOptions;
};

type OwnerRead =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" | "unreadable"; readonly detail: string }
  | { readonly kind: "valid"; readonly owner: LifecycleLockOwner };
type ProcessStat =
  | { readonly kind: "found"; readonly startTicks: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unknown" };

export async function acquireLifecycleLock(request: LifecycleLockRequest): Promise<() => Promise<void>> {
  const directory = path.join(request.root, "locks");
  const ownerPath = path.join(directory, `${request.name}.lock`);
  const guardPath = path.join(directory, `${request.name}.guard`);
  const options = request.options ?? {};
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeout = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const retryDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const identity = await currentProcessIdentity();
  const owner: LifecycleLockOwner = {
    version: LOCK_OWNER_VERSION,
    pid: process.pid,
    bootId: identity.bootId,
    processStartTicks: identity.processStartTicks,
    acquiredAt: new Date(now()).toISOString(),
    nonce: randomBytes(32).toString("base64url")
  };
  const startedAt = now();
  let diagnostic = `lock is held by another process`;
  await mkdir(directory, { recursive: true, mode: 0o700 });

  for (;;) {
    const guard = await tryAcquireKernelGuard(guardPath);
    if (guard !== undefined) {
      let ownershipTransferred = false;
      try {
        const existing = await readOwner(ownerPath);
        switch (existing.kind) {
          case "missing":
            await publishOwner(ownerPath, owner);
            ownershipTransferred = true;
            return releaseOwner(ownerPath, owner, guard);
          case "malformed":
          case "unreadable":
            diagnostic = `${existing.kind} owner record for ${request.description}: ${existing.detail}`;
            break;
          case "valid": {
            const status = await (options.probeProcess ?? probeProcess)(existing.owner);
            switch (status) {
              case "dead":
              case "reused":
                await publishOwner(ownerPath, owner);
                ownershipTransferred = true;
                return releaseOwner(ownerPath, owner, guard);
              case "live":
                diagnostic = `${request.description} lock is owned by live process instance ${existing.owner.pid}`;
                break;
              case "unknown":
                diagnostic = `${request.description} owner process instance cannot be verified`;
                break;
              default:
                assertNever(status);
            }
            break;
          }
          default:
            assertNever(existing);
        }
      } finally {
        if (!ownershipTransferred) await guard.release();
      }
    }
    const elapsed = now() - startedAt;
    if (elapsed >= timeout) break;
    await sleep(Math.min(retryDelay, timeout - elapsed));
  }
  throw new UserError(`${diagnostic}; timed out waiting for ${request.description} lock`);
}

async function currentProcessIdentity(): Promise<Pick<LifecycleLockOwner, "bootId" | "processStartTicks">> {
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const stat = await readProcessStat(process.pid);
  if (!CANONICAL_LOWERCASE_UUID_PATTERN.test(bootId) || stat.kind !== "found") {
    throw new UserError("cannot identify the current Linux process instance for lifecycle locking");
  }
  return { bootId, processStartTicks: stat.startTicks };
}

async function probeProcess(owner: LifecycleLockOwner): Promise<ProcessProbeResult> {
  let bootId: string;
  try {
    bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  } catch (error) {
    if (error instanceof Error) return "unknown";
    throw error;
  }
  if (bootId !== owner.bootId) return "reused";
  let stat: ProcessStat;
  try {
    stat = await readProcessStat(owner.pid);
  } catch (error) {
    if (error instanceof Error) return "unknown";
    throw error;
  }
  switch (stat.kind) {
    case "found":
      return stat.startTicks === owner.processStartTicks ? "live" : "reused";
    case "missing":
      return "dead";
    case "unknown":
      return "unknown";
    default:
      return assertNever(stat);
  }
}

async function readProcessStat(pid: number): Promise<ProcessStat> {
  let value: string;
  try {
    value = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    if (errorCode(error) === "EACCES" || errorCode(error) === "EPERM") return { kind: "unknown" };
    throw error;
  }
  const commandEnd = value.lastIndexOf(")");
  const fields = commandEnd < 0 ? [] : value.slice(commandEnd + 1).trim().split(/\s+/);
  const startTicks = fields[19];
  return startTicks !== undefined && /^\d+$/.test(startTicks)
    ? { kind: "found", startTicks }
    : { kind: "unknown" };
}

async function readOwner(ownerPath: string): Promise<OwnerRead> {
  let content: string;
  try {
    content = await readFile(ownerPath, "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "EACCES" || code === "EPERM") return { kind: "unreadable", detail: code };
    throw error;
  }
  try {
    const value: unknown = JSON.parse(content);
    const owner = parseOwner(value);
    return owner === undefined
      ? { kind: "malformed", detail: "record fields are invalid" }
      : { kind: "valid", owner };
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: "malformed", detail: "record is not valid JSON" };
    throw error;
  }
}

function parseOwner(value: unknown): LifecycleLockOwner | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !("version" in value) || value.version !== LOCK_OWNER_VERSION
    || !("pid" in value) || !Number.isSafeInteger(value.pid) || typeof value.pid !== "number" || value.pid < 1
    || !("bootId" in value) || typeof value.bootId !== "string" || !CANONICAL_LOWERCASE_UUID_PATTERN.test(value.bootId)
    || !("processStartTicks" in value) || typeof value.processStartTicks !== "string" || !/^\d+$/.test(value.processStartTicks)
    || !("acquiredAt" in value) || typeof value.acquiredAt !== "string" || !Number.isFinite(Date.parse(value.acquiredAt))
    || !("nonce" in value) || typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.nonce)) {
    return undefined;
  }
  return {
    version: LOCK_OWNER_VERSION,
    pid: value.pid,
    bootId: value.bootId,
    processStartTicks: value.processStartTicks,
    acquiredAt: value.acquiredAt,
    nonce: value.nonce
  };
}

async function publishOwner(ownerPath: string, owner: LifecycleLockOwner): Promise<void> {
  const prefix = `${path.basename(ownerPath)}.tmp-`;
  const directory = path.dirname(ownerPath);
  for (const entry of await readdir(directory)) {
    if (entry.startsWith(prefix)) await rm(path.join(directory, entry), { force: true });
  }
  const temporary = path.join(directory, `${prefix}${owner.nonce}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, ownerPath);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
}

function releaseOwner(ownerPath: string, owner: LifecycleLockOwner, guard: KernelGuard): () => Promise<void> {
  let active = true;
  return async () => {
    if (!active) return;
    active = false;
    try {
      const current = await readOwner(ownerPath);
      if (current.kind !== "valid" || current.owner.nonce !== owner.nonce) {
        throw new UserError(`lifecycle lock ownership changed before nonce ${owner.nonce} could release it`);
      }
      await rm(ownerPath);
      await syncDirectory(path.dirname(ownerPath));
    } finally {
      await guard.release();
    }
  };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function assertNever(value: never): never {
  throw new UserError(`unexpected lifecycle lock state: ${JSON.stringify(value)}`);
}
