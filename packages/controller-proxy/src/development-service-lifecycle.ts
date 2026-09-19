import { chmod, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { gatewayIsReady } from "./development-service-control.js";
import { createDevelopmentServiceGateway } from "./development-service-gateway.js";
import {
  DEVELOPMENT_SERVICE_GATEWAY_PORT,
  developmentServiceControlSocket,
  prepareStateDirectory
} from "./development-service-state.js";

const START_TIMEOUT_MILLISECONDS = 5_000;

type ProcessIdentity = {
  readonly pid: number;
  readonly startTime: string;
};

export async function ensureDevelopmentServiceGateway(
  stateDirectory: string,
  executablePath: string
): Promise<string> {
  await prepareStateDirectory(stateDirectory);
  const controlSocket = developmentServiceControlSocket(stateDirectory);
  if (await gatewayIsReady(controlSocket)) return controlSocket;
  const lockDirectory = path.join(stateDirectory, "gateway.start.lock");
  if (!await acquireStartLock(lockDirectory)) {
    await waitUntilReady(controlSocket);
    return controlSocket;
  }
  try {
    if (await gatewayIsReady(controlSocket)) return controlSocket;
    const logPath = path.join(stateDirectory, "gateway.log");
    const log = await open(logPath, "a", 0o600);
    await chmod(logPath, 0o600);
    try {
      const child = spawn(process.execPath, [executablePath, "__gateway", "--state-directory", stateDirectory], {
        detached: true,
        stdio: ["ignore", log.fd, log.fd]
      });
      child.unref();
    } finally {
      await log.close();
    }
    await waitUntilReady(controlSocket);
    return controlSocket;
  } finally {
    await rm(lockDirectory, { recursive: true, force: true });
  }
}

export async function runDevelopmentServiceGateway(stateDirectory: string): Promise<void> {
  await prepareStateDirectory(stateDirectory);
  const gateway = createDevelopmentServiceGateway({
    listenPort: DEVELOPMENT_SERVICE_GATEWAY_PORT,
    stateDirectory
  });
  await gateway.listen();
  const identityPath = path.join(stateDirectory, "gateway.identity.json");
  const identity = await currentIdentity();
  await writeFile(identityPath, `${JSON.stringify(identity)}\n`, { mode: 0o600 });
  await chmod(identityPath, 0o600);
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void gateway.close()
        .then(() => removeOwnedIdentity(identityPath, identity))
        .then(resolve, (error: unknown) => {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
          process.exitCode = 1;
          resolve();
        });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function acquireStartLock(lockDirectory: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      const identity = await currentIdentity();
      await writeFile(path.join(lockDirectory, "owner.json"), `${JSON.stringify(identity)}\n`, {
        mode: 0o600,
        flag: "wx"
      });
      return true;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      if (await lockOwnerIsAlive(lockDirectory)) return false;
      await rm(lockDirectory, { recursive: true, force: true });
    }
  }
  return false;
}

async function lockOwnerIsAlive(lockDirectory: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(lockDirectory, "owner.json"), "utf8"));
    const identity = parseIdentity(parsed);
    return await processMatches(identity);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
    const metadata = await stat(lockDirectory);
    return Date.now() - metadata.mtimeMs < START_TIMEOUT_MILLISECONDS;
  }
}

async function waitUntilReady(controlSocket: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline) {
    if (await gatewayIsReady(controlSocket)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new DevelopmentServiceLifecycleError("development service gateway did not become ready within 5 seconds");
}

async function currentIdentity(): Promise<ProcessIdentity> {
  const startTime = await linuxProcessStartTime(process.pid);
  return { pid: process.pid, startTime };
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
    throw new DevelopmentServiceLifecycleError(`could not read process identity for PID ${pid}`);
  }
  return startTime;
}

async function removeOwnedIdentity(identityPath: string, expected: ProcessIdentity): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await readFile(identityPath, "utf8"));
    const current = parseIdentity(parsed);
    if (current.pid === expected.pid && current.startTime === expected.startTime) {
      await rm(identityPath);
    }
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

function parseIdentity(value: unknown): ProcessIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !("pid" in value) || !("startTime" in value)
    || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid < 1
    || typeof value.startTime !== "string" || !/^\d+$/.test(value.startTime)) {
    throw new DevelopmentServiceLifecycleError("gateway process identity is invalid");
  }
  return { pid: value.pid, startTime: value.startTime };
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class DevelopmentServiceLifecycleError extends Error {
  readonly name = "DevelopmentServiceLifecycleError";
}
