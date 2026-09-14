import { spawn, type ChildProcessByStdio } from "node:child_process";
import { watch } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request, type ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { afterEach } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const serviceScript = resolve(workspaceRoot, "project/.dim/qemu-service.mjs");
const fixtures: ServiceFixture[] = [];
const fixtureRoots: string[] = [];

export type ServiceFixture = { readonly launcherPidFile: string; readonly launcherStopFile: string;
  readonly process: ChildProcessByStdio<null, Readable, Readable>; readonly recordFile: string;
  readonly root: string; readonly runsRoot: string; readonly socketPath: string;
  readonly sourceRoot: string; readonly spawnRecordFile: string };

export type HttpResult = { readonly body: string; readonly status: number };
export type RequestSpec = { readonly body?: unknown; readonly method: string; readonly path: string };
export type LauncherInput = { readonly name: string; readonly path: string };
export type SpawnRecord = { readonly arguments: readonly string[]; readonly command: string };
export type IncompleteRun = { readonly abort: () => void; readonly continued: Promise<void>;
  readonly finish: () => void; readonly response: Promise<HttpResult> };
export type ServiceOptions = { readonly forceResponseBackpressure?: boolean;
  readonly ignoreLauncherTerm?: boolean; readonly rejectReaddir?: boolean };

function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }

function parseInput(value: unknown): LauncherInput {
  if (typeof value !== "object" || value === null || !("name" in value) || !("path" in value)
    || typeof value.name !== "string" || typeof value.path !== "string") {
    throw new TypeError("launcher input record is invalid");
  }
  return { name: value.name, path: value.path };
}

function parseSpawn(value: unknown): SpawnRecord {
  if (typeof value !== "object" || value === null || !("command" in value) || !("arguments" in value)
    || typeof value.command !== "string" || !Array.isArray(value.arguments)
    || !value.arguments.every((argument) => typeof argument === "string")) {
    throw new TypeError("spawn record is invalid");
  }
  return { arguments: value.arguments, command: value.command };
}

async function jsonLines(path: string): Promise<readonly unknown[]> {
  try {
    const content = (await readFile(path, "utf8")).trim();
    return content === "" ? [] : content.split("\n").map((line) => JSON.parse(line));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

export async function launchRecords(fixture: ServiceFixture): Promise<readonly (readonly LauncherInput[])[]> {
  return (await jsonLines(fixture.recordFile)).map((value) => {
    if (!Array.isArray(value)) throw new TypeError("launcher record must be an array");
    return value.map(parseInput);
  });
}

export async function spawnRecords(fixture: ServiceFixture): Promise<readonly SpawnRecord[]> {
  return (await jsonLines(fixture.spawnRecordFile)).map(parseSpawn);
}

export async function startService(mode: "exit" | "hold", options: ServiceOptions = {}): Promise<ServiceFixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-service-test-"));
  fixtureRoots.push(root);
  const sourceRoot = resolve(root, "source");
  const recordFile = resolve(root, "launches.jsonl");
  const spawnRecordFile = resolve(root, "spawns.jsonl");
  const socketPath = resolve(root, "service.sock");
  const launcherPidFile = resolve(root, "launcher.pid");
  const launcherStopFile = resolve(root, "launcher.stopped");
  const launcher = resolve(root, "launcher.bash");
  const preload = resolve(root, "record-spawns.mjs");
  await mkdir(sourceRoot);
  await writeFile(preload, `import childProcess from "node:child_process";
import fs, { appendFileSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = childProcess.spawn;
childProcess.spawn = function instrumentedSpawn(command, args, options) {
  appendFileSync(process.env.DIM_TEST_SPAWN_RECORD, JSON.stringify({ command, arguments: args ?? [] }) + "\\n");
  return originalSpawn.call(childProcess, command, args, options);
};
if (process.env.DIM_TEST_REJECT_READDIR === "1") {
  fs.promises.readdir = async function rejectedReaddir() { throw new Error("DIM_TEST_READDIR_FORBIDDEN"); };
}
if (process.env.DIM_TEST_FORCE_BACKPRESSURE === "1") {
  const originalWrite = http.ServerResponse.prototype.write;
  http.ServerResponse.prototype.write = function forcedBackpressure(...args) { originalWrite.apply(this, args); return false; };
}
syncBuiltinESMExports();
`);
  await writeFile(launcher, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$$" >"$DIM_TEST_LAUNCHER_PID"
printf '%s\n' "$DIM_QEMU_INPUT_SNAPSHOTS_JSON" >>"$DIM_TEST_LAUNCH_RECORD"
printf 'ready\n'
[[ "$DIM_TEST_LAUNCHER_MODE" != exit ]] || exit 0
if [[ "$DIM_TEST_IGNORE_TERM" == 1 ]]; then
  trap '' TERM INT
  bash -c 'trap "" TERM INT; exec sleep 86400' &
else
  sleep 86400 &
  trap 'kill "$sleeper" >/dev/null 2>&1 || true; wait "$sleeper" 2>/dev/null || true; printf stopped >"$DIM_TEST_LAUNCHER_STOPPED"; exit 0' TERM INT
fi
sleeper=$!
wait "$sleeper"
`);
  await chmod(launcher, 0o700);
  const stderr: Buffer[] = [];
  const watcher = watch(root);
  const child = spawn(process.execPath, ["--import", preload, serviceScript], {
    env: {
      ...process.env,
      DIM_QEMU_LAUNCHER: launcher,
      DIM_QEMU_SERVICE_SOCKET: socketPath,
      DIM_QEMU_SOURCE_ROOT: sourceRoot,
      DIM_TEST_LAUNCHER_MODE: mode,
      DIM_TEST_LAUNCHER_PID: launcherPidFile,
      DIM_TEST_LAUNCHER_STOPPED: launcherStopFile,
      DIM_TEST_LAUNCH_RECORD: recordFile,
      DIM_TEST_FORCE_BACKPRESSURE: options.forceResponseBackpressure === true ? "1" : "0",
      DIM_TEST_IGNORE_TERM: options.ignoreLauncherTerm === true ? "1" : "0",
      DIM_TEST_REJECT_READDIR: options.rejectReaddir === true ? "1" : "0",
      DIM_TEST_SPAWN_RECORD: spawnRecordFile
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const fixture = {
    launcherPidFile, launcherStopFile, process: child, recordFile, root,
    runsRoot: resolve(root, "runs"), socketPath, sourceRoot, spawnRecordFile
  };
  fixtures.push(fixture);
  await new Promise<void>((resolveReady, rejectReady) => {
    watcher.on("change", (_event, filename) => {
      if (filename?.toString() !== "service.pid" && filename?.toString() !== "service-owner.json") return;
      watcher.close();
      resolveReady();
    });
    child.once("exit", (code) => {
      watcher.close();
      rejectReady(new TypeError(`QEMU service exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
  await waitForObservation(async () => {
    try { await stat(fixture.runsRoot); return true; }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
      return undefined;
    }
  });
  return fixture;
}

function responseFrom(outgoing: ClientRequest): Promise<HttpResult> {
  return new Promise((resolveResponse, rejectResponse) => {
    outgoing.once("response", (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("end", () => resolveResponse({
        body: Buffer.concat(chunks).toString("utf8"),
        status: incoming.statusCode ?? 0
      }));
    });
    outgoing.once("error", rejectResponse);
  });
}

export function http(fixture: ServiceFixture, spec: RequestSpec): Promise<HttpResult> {
  const body = spec.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(spec.body));
  const outgoing = request({
    socketPath: fixture.socketPath, method: spec.method, path: spec.path,
    headers: body.length === 0 ? undefined : { "content-length": body.length, "content-type": "application/json" }
  });
  const response = responseFrom(outgoing);
  outgoing.end(body);
  return response;
}

export function incompleteRun(fixture: ServiceFixture): IncompleteRun {
  const body = Buffer.from(JSON.stringify({ inputs: [], mode: "run", verbose: false }));
  const outgoing = request({
    socketPath: fixture.socketPath, method: "POST", path: "/v1/run",
    headers: { "content-length": body.length, "content-type": "application/json", expect: "100-continue" }
  });
  const continued = new Promise<void>((resolveContinue, rejectContinue) => {
    outgoing.once("continue", resolveContinue);
    outgoing.once("error", rejectContinue);
  });
  const response = responseFrom(outgoing);
  outgoing.flushHeaders();
  return { abort: () => outgoing.destroy(), continued, finish: () => outgoing.end(body), response };
}

export function readEvents(fixture: ServiceFixture, marker?: string): Promise<string> {
  return new Promise((resolveEvents, rejectEvents) => {
    const outgoing = request({ socketPath: fixture.socketPath, method: "GET", path: "/v1/events" }, (incoming) => {
      let output = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        output += chunk;
        if (marker !== undefined && output.includes(marker)) {
          resolveEvents(output);
          outgoing.destroy();
        }
      });
      incoming.once("end", () => {
        if (marker === undefined || output.includes(marker)) resolveEvents(output);
        else rejectEvents(new TypeError(`event stream ended before ${marker}`));
      });
    });
    outgoing.once("error", rejectEvents);
    outgoing.end();
  });
}

export async function waitForExit(fixture: ServiceFixture, timeoutMilliseconds = 1_000): Promise<boolean> {
  if (fixture.process.exitCode !== null || fixture.process.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolveExit(true);
    };
    const timer = setTimeout(() => {
      fixture.process.off("exit", onExit);
      resolveExit(false);
    }, timeoutMilliseconds);
    fixture.process.once("exit", onExit);
  });
}

export async function waitForObservation<T>(observe: () => Promise<T | undefined>, timeoutMilliseconds = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const observation = await observe();
    if (observation !== undefined) return observation;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  }
  throw new TypeError("timed out waiting for fixture observation");
}

async function stopService(fixture: ServiceFixture): Promise<void> {
  if (fixture.process.exitCode === null && fixture.process.signalCode === null) {
    fixture.process.kill("SIGTERM");
    if (!(await waitForExit(fixture))) {
      fixture.process.kill("SIGKILL");
      await waitForExit(fixture);
    }
  }
  try {
    const launcherPid = Number.parseInt(await readFile(fixture.launcherPidFile, "utf8"), 10);
    if (Number.isSafeInteger(launcherPid)) process.kill(-launcherPid, "SIGKILL");
  } catch (error) {
    if (!isMissing(error) && (!(error instanceof Error) || !error.message.includes("ESRCH"))) throw error;
  }
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(stopService));
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
