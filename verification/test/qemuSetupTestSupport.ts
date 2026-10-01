import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { resolve } from "node:path";
import { waitForObservation } from "./qemuServiceTestSupport.js";

type OwnedServiceFixture = {
  readonly oldLifecycleRoot: string;
  readonly root: string;
  readonly serviceDirectory: string;
};

export function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("ESRCH")) return false;
    throw error;
  }
}

export async function ownerPid(serviceDirectory: string): Promise<number> {
  const value: unknown = JSON.parse(await readFile(resolve(serviceDirectory, "service-owner.json"), "utf8"));
  if (typeof value !== "object" || value === null || !("pid" in value) || typeof value.pid !== "string") {
    throw new TypeError("structured owner PID is missing");
  }
  return Number.parseInt(value.pid, 10);
}

export async function serviceStatus(socketPath: string): Promise<number | undefined> {
  return new Promise((resolveStatus, rejectStatus) => {
    const outgoing = request({ socketPath, method: "GET", path: "/v1/status" }, (incoming) => {
      incoming.resume();
      incoming.once("end", () => resolveStatus(incoming.statusCode));
    });
    outgoing.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolveStatus(undefined);
      else rejectStatus(error);
    });
    outgoing.end();
  });
}

export function startOwnedServiceProcess(fixture: OwnedServiceFixture): {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
} {
  const socketPath = resolve(fixture.serviceDirectory, "service.sock");
  const sourceRoot = resolve(fixture.root, "source");
  mkdirSync(sourceRoot);
  const ready = waitForObservation(async () => {
    try { return JSON.parse(await readFile(resolve(fixture.serviceDirectory, "service-owner.json"), "utf8")); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }).then(() => waitForObservation(async () => await serviceStatus(socketPath) === 200 ? true : undefined)).then(() => undefined);
  const child = spawn(process.execPath, ["--import", resolve(fixture.root, "signal-preload.mjs"),
    resolve(fixture.oldLifecycleRoot, ".dim/qemu-service.mjs")], {
    cwd: fixture.serviceDirectory,
    env: { ...process.env, DIM_QEMU_LAUNCHER: "/bin/false", DIM_QEMU_SERVICE_SOCKET: socketPath, DIM_QEMU_SOURCE_ROOT: sourceRoot,
      DIM_TEST_ACTIVATION_RELEASE: resolve(fixture.root, "activation-release"),
      DIM_TEST_ACTIVATION_STARTED: resolve(fixture.root, "activation-started"),
      DIM_TEST_BLOCK_ACTIVATION: "1", DIM_TEST_ROOT: fixture.root,
      DIM_TEST_RUNS_ROOT: resolve(fixture.serviceDirectory, "runs") },
    stdio: "ignore",
  });
  return { child, ready };
}

export function ownershipSignalPreloadScript(): string {
  return `import fs, { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
if (process.env.DIM_TEST_READINESS === "mismatch") {
  process.on("SIGTERM", () => appendFileSync(process.env.DIM_TEST_SIGNAL_LOG, "SIGTERM\\n"));
}
if (process.env.DIM_TEST_BLOCK_ACTIVATION === "1") {
  const originalRename = fs.promises.rename;
  fs.promises.rename = async function blockedActivation(source, destination) {
    if (typeof source === "string" && source.includes("runs.prepared-") && destination === process.env.DIM_TEST_RUNS_ROOT) {
      appendFileSync(process.env.DIM_TEST_ACTIVATION_STARTED, "started\\n");
      await new Promise((resolveRelease) => {
        const release = process.env.DIM_TEST_ACTIVATION_RELEASE;
        const complete = () => {
          if (!fs.existsSync(release)) return;
          watcher.close();
          resolveRelease();
        };
        const watcher = fs.watch(process.env.DIM_TEST_ROOT, (_event, name) => {
          if (name === "activation-release") complete();
        });
        complete();
      });
    }
    return originalRename.call(fs.promises, source, destination);
  };
  syncBuiltinESMExports();
}
`;
}
