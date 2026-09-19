import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  acquireProcessLock,
  processIdentityStatus,
  processOwnsUnixSocket,
  processStartTime,
  type ProcessIdentity
} from "./managed-process.js";

export type ManagedProxyCommand = {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly identityMarker: string;
  readonly environment: NodeJS.ProcessEnv;
};

export type ManagedProxyOptions = {
  readonly listen: string;
  readonly fingerprint: string;
  readonly command: ManagedProxyCommand;
  readonly startupTimeoutMs?: number;
  readonly terminationTimeoutMs?: number;
};

export type ManagedProxyResult = {
  readonly action: "started" | "restarted" | "reused";
  readonly pid: number;
};

type ManagedProxyState = ProcessIdentity & {
  readonly version: 1;
  readonly fingerprint: string;
};

export class ManagedProxyError extends Error {
  readonly name = "ManagedProxyError";
}

const POLL_INTERVAL_MS = 25;
const DEFAULT_TIMEOUT_MS = 5_000;

export function managedProxyStatePath(listen: string): string {
  return `${path.resolve(listen)}.managed.json`;
}

export function managedProxyFingerprint(configuration: string): string {
  return createHash("sha256").update(configuration).digest("hex");
}

export async function ensureManagedProxy(options: ManagedProxyOptions): Promise<ManagedProxyResult> {
  const listen = path.resolve(options.listen);
  await mkdir(path.dirname(listen), { recursive: true, mode: 0o700 });
  const release = await acquireProcessLock(
    `${listen}.ensure.lock`,
    options.startupTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    POLL_INTERVAL_MS
  );
  try {
    return await reconcile({ ...options, listen });
  } finally {
    await release();
  }
}

async function reconcile(options: ManagedProxyOptions): Promise<ManagedProxyResult> {
  const statePath = managedProxyStatePath(options.listen);
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const state = await readState(statePath);
  let action: ManagedProxyResult["action"] = "started";
  if (state === undefined) {
    if (await pathExists(options.listen)) {
      throw new ManagedProxyError(`managed proxy socket exists without owned process state: ${options.listen}`);
    }
  } else {
    const status = await processIdentityStatus(state, options.command.identityMarker);
    if (status === "mismatched") {
      throw new ManagedProxyError(`managed proxy PID ${state.pid} has an unknown process identity`);
    }
    if (status === "matching" && state.fingerprint === options.fingerprint
      && await socketReady(
        options.listen,
        state,
        options.command.identityMarker,
        Math.min(POLL_INTERVAL_MS * 2, startupTimeoutMs)
      )) {
      return { action: "reused", pid: state.pid };
    }
    if (status === "matching") {
      await terminate(state, options.command.identityMarker, options.terminationTimeoutMs ?? DEFAULT_TIMEOUT_MS);
      action = "restarted";
    }
    await rm(statePath, { force: true });
  }
  const child = await spawnManagedProxy(options.command);
  child.unref();
  const startTime = await processStartTime(child.pid);
  if (startTime === undefined) throw new ManagedProxyError("managed proxy process exited before identity capture");
  const identity = { pid: child.pid, startTime };
  try {
    await waitForReadiness(
      options.listen,
      identity,
      options.command.identityMarker,
      startupTimeoutMs
    );
    await writeState(statePath, { version: 1, ...identity, fingerprint: options.fingerprint });
  } catch (error) {
    await terminate(identity, options.command.identityMarker, options.terminationTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    throw error;
  }
  return { action, pid: child.pid };
}

async function spawnManagedProxy(command: ManagedProxyCommand): Promise<ChildProcess & { readonly pid: number }> {
  const child = spawn(command.executable, command.arguments, {
    detached: true,
    stdio: "ignore",
    env: command.environment
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    throw new ManagedProxyError(`failed to spawn managed proxy: ${command.executable}`, { cause: error });
  }
  if (child.pid === undefined) throw new ManagedProxyError("managed proxy process did not receive a PID");
  return Object.assign(child, { pid: child.pid });
}

async function terminate(identity: ProcessIdentity, commandMarker: string, timeoutMs: number): Promise<void> {
  if (!await signalOwnedProcess(identity, commandMarker, "SIGTERM")) return;
  if (await waitForExit(identity, timeoutMs)) return;
  if (!await signalOwnedProcess(identity, commandMarker, "SIGKILL")) return;
  if (!await waitForExit(identity, timeoutMs)) {
    throw new ManagedProxyError(`managed proxy PID ${identity.pid} did not terminate within the bounded timeout`);
  }
}

async function waitForReadiness(
  listen: string,
  identity: ProcessIdentity,
  commandMarker: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (await socketReady(listen, identity, commandMarker, Math.min(POLL_INTERVAL_MS * 2, remaining))) return;
    if (await processIdentityStatus(identity) !== "matching") {
      throw new ManagedProxyError("managed proxy process exited before becoming ready");
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new ManagedProxyError(`managed proxy did not become ready within ${timeoutMs}ms`);
}

async function signalOwnedProcess(
  identity: ProcessIdentity,
  commandMarker: string,
  signal: NodeJS.Signals
): Promise<boolean> {
  const status = await processIdentityStatus(identity, commandMarker);
  if (status === "dead") return false;
  if (status === "mismatched") {
    throw new ManagedProxyError(`managed proxy PID ${identity.pid} has an unknown process identity`);
  }
  process.kill(identity.pid, signal);
  return true;
}

async function waitForExit(identity: ProcessIdentity, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await processIdentityStatus(identity) !== "matching") return true;
    await delay(POLL_INTERVAL_MS);
  }
  return false;
}

async function socketReady(
  listen: string,
  identity: ProcessIdentity,
  commandMarker: string,
  timeoutMs: number
): Promise<boolean> {
  const connected = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(listen);
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(ready);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
  return connected
    && await processIdentityStatus(identity, commandMarker) === "matching"
    && await processOwnsUnixSocket(identity.pid, listen);
}

async function readState(statePath: string): Promise<ManagedProxyState | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(statePath, "utf8"));
    const identity = processIdentity(value);
    if (identity === undefined || !isObject(value) || value.version !== 1
      || typeof value.fingerprint !== "string" || value.fingerprint.length === 0) {
      throw new ManagedProxyError(`invalid managed proxy state: ${statePath}`);
    }
    return { version: 1, ...identity, fingerprint: value.fingerprint };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeState(statePath: string, state: ManagedProxyState): Promise<void> {
  const temporary = `${statePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporary, statePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function processIdentity(value: unknown): ProcessIdentity | undefined {
  if (!isObject(value) || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1
    || typeof value.startTime !== "string" || !/^\d+$/.test(value.startTime)) return undefined;
  return { pid: Number(value.pid), startTime: value.startTime };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
