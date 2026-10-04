import { link, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  UserError,
  type LifecycleOptions
} from "@slop-lab/dim-core";
import { runner } from "./cli-runtime.js";
import { managedControllerReady, processExists } from "./controller-health.js";
import { startSystemdManagedController, usesSystemdManagedController } from "./systemd-controller.js";
import { adminErrorDetail, unixHttpRequest } from "./controller-transport.js";

const managedControllerStartAttempts = 2400;
const managedControllerStopAttempts = 200;

export async function ensureManagedController(options: LifecycleOptions): Promise<void> {
  if (await managedControllerReady(options)) return;
  if (usesSystemdManagedController(options)) {
    await startSystemdManagedController(options);
    return;
  }
  const runtimeDir = options.controllerRuntimeDirectory;
  const lockDir = path.join(runtimeDir, "ensure.lock");
  await mkdir(runtimeDir, { recursive: true });
  let ownsLock = false;
  for (let attempt = 0; attempt < managedControllerStartAttempts; attempt += 1) {
    try {
      await mkdir(lockDir);
      ownsLock = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await managedControllerReady(options)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!ownsLock) {
    await rm(lockDir, { recursive: true, force: true });
    return ensureManagedController(options);
  }
  try {
    if (await managedControllerReady(options)) return;
    await rm(options.controllerSocketPath, { force: true });
    await rm(options.agentControllerSocketPath, { force: true });
    await rm(options.adminControllerSocketPath, { force: true });
    const log = await open(path.join(runtimeDir, "controller.log"), "a");
    const script = process.argv[1];
    if (!script) throw new UserError("cannot locate the DIM CLI entrypoint");
    const child = spawn(process.execPath, [
      ...process.execArgv,
      script,
      "controller",
      "serve",
      "--socket",
      options.controllerSocketPath,
      "--agent-socket",
      options.agentControllerSocketPath,
      "--admin-socket",
      options.adminControllerSocketPath,
      "--pid-file",
      path.join(options.controllerRuntimeDirectory, "controller.pid")
    ], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: process.env
    });
    child.unref();
    await log.close();
    for (let attempt = 0; attempt < managedControllerStartAttempts; attempt += 1) {
      if (await managedControllerReady(options)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new UserError(`managed controller failed to start; see ${path.join(runtimeDir, "controller.log")}`);
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

export async function claimControllerPid(pidPath: string): Promise<void> {
  const candidateDirectory = await mkdtemp(path.join(path.dirname(pidPath), ".controller-pid-"));
  const candidatePath = path.join(candidateDirectory, "pid");
  await writeFile(candidatePath, `${process.pid}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await link(candidatePath, pidPath);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existingPid: number | undefined;
        try {
          existingPid = Number((await readFile(pidPath, "utf8")).trim());
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
          continue;
        }
        if (Number.isSafeInteger(existingPid) && existingPid > 1 && processExists(existingPid)) {
          throw new UserError(`managed controller process ${existingPid} is already running`);
        }
        await rm(pidPath, { force: true });
      }
    }
    throw new UserError(`could not claim managed controller PID file at ${pidPath}`);
  } finally {
    await rm(candidateDirectory, { recursive: true, force: true });
  }
}

export async function pidFileOwnedByCurrentProcess(pidPath: string): Promise<boolean> {
  try {
    return Number((await readFile(pidPath, "utf8")).trim()) === process.pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function prepareControllerSocket(socketPath: string): Promise<void> {
  await mkdir(path.dirname(socketPath), { recursive: true });
  if (await unixSocketAcceptingConnections(socketPath)) {
    throw new UserError(`controller socket is already in use at ${socketPath}`);
  }
  await rm(socketPath, { force: true });
}

export async function unixSocketAcceptingConnections(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

export async function stopManagedController(options: LifecycleOptions): Promise<void> {
  if (usesSystemdManagedController(options)) {
    const result = await runner.run("systemctl", ["--user", "stop", "dim-controller.service"]);
    if (result.exitCode !== 0 && !result.stderr.includes("not loaded")) {
      throw new UserError(`could not stop DIM controller: ${result.stderr.trim()}`);
    }
    return;
  }
  const pidPath = path.join(options.controllerRuntimeDirectory, "controller.pid");
  try {
    const pidFile = await lstat(pidPath);
    const uid = process.getuid?.();
    if (uid === undefined || !pidFile.isFile() || pidFile.isSymbolicLink()
      || pidFile.uid !== uid || (pidFile.mode & 0o777) !== 0o600) {
      throw new UserError(`managed controller PID file at ${pidPath} is not owned safely`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let adminSocket: Awaited<ReturnType<typeof lstat>>;
  try {
    adminSocket = await lstat(options.adminControllerSocketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UserError("managed controller PID file exists without an admin socket");
    }
    throw error;
  }
  const uid = process.getuid?.();
  if (uid === undefined || !adminSocket.isSocket() || adminSocket.isSymbolicLink()
    || adminSocket.uid !== uid || (adminSocket.mode & 0o777) !== 0o600) {
    throw new UserError(`managed controller admin socket at ${options.adminControllerSocketPath} is not owned safely`);
  }
  let response: Awaited<ReturnType<typeof unixHttpRequest>>;
  try {
    response = await unixHttpRequest(
      options.adminControllerSocketPath,
      "/v1/controller/stop",
      { method: "POST", signal: AbortSignal.timeout(5_000) }
    );
  } catch (error) {
    throw new UserError("could not request managed controller self-termination", { cause: error });
  }
  if (response.status !== 202) {
    const detail = adminErrorDetail(response.body);
    throw new UserError(
      `managed controller refused self-termination (${response.status})${detail ? `: ${detail}` : ""}`
    );
  }
  for (let attempt = 0; attempt < managedControllerStopAttempts; attempt += 1) {
    let pidFileRemoved = false;
    try {
      await readFile(pidPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      pidFileRemoved = true;
    }
    if (pidFileRemoved
      && !await unixSocketAcceptingConnections(options.controllerSocketPath)
      && !await unixSocketAcceptingConnections(options.agentControllerSocketPath)
      && !await unixSocketAcceptingConnections(options.adminControllerSocketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new UserError("managed controller did not complete self-termination");
}

export async function restartManagedController(options: LifecycleOptions): Promise<void> {
  if (usesSystemdManagedController(options)) {
    await startSystemdManagedController(options);
    return;
  }
  await stopManagedController(options);
  await rm(options.controllerSocketPath, { force: true });
  await rm(options.agentControllerSocketPath, { force: true });
  await rm(options.adminControllerSocketPath, { force: true });
  await ensureManagedController(options);
}
