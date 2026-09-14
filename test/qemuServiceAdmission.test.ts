import { spawn, type ChildProcessByStdio } from "node:child_process";
import { watch } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { request, type ClientRequest } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const serviceScript = resolve(workspaceRoot, "project/.dim/qemu-service.mjs");
type ServiceFixture = { readonly process: ChildProcessByStdio<null, Readable, Readable>; readonly recordFile: string; readonly socketPath: string; readonly sourceRoot: string };
type HttpResult = { readonly body: string; readonly status: number };
type RequestSpec = { readonly body?: unknown; readonly method: string; readonly path: string };
type LauncherInput = { readonly name: string; readonly path: string };
type IncompleteRun = { readonly continued: Promise<void>; readonly finish: () => void; readonly response: Promise<HttpResult> };

const fixtures: ServiceFixture[] = [];
const fixtureRoots: string[] = [];
const fixtureServers: Server[] = [];

function parseInput(value: unknown): LauncherInput {
  if (typeof value !== "object" || value === null || !("name" in value) || !("path" in value)
    || typeof value.name !== "string" || typeof value.path !== "string") {
    throw new TypeError("launcher input record is invalid");
  }
  return { name: value.name, path: value.path };
}

async function launchRecords(fixture: ServiceFixture): Promise<readonly (readonly LauncherInput[])[]> {
  return (await readFile(fixture.recordFile, "utf8")).trim().split("\n").map((line) => {
    const value: unknown = JSON.parse(line);
    if (!Array.isArray(value)) throw new TypeError("launcher record must be an array");
    return value.map(parseInput);
  });
}

async function startService(mode: "exit" | "hold"): Promise<ServiceFixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-service-test-"));
  fixtureRoots.push(root);
  const sourceRoot = resolve(root, "source");
  const recordFile = resolve(root, "launches.jsonl");
  const socketPath = resolve(root, "service.sock");
  const launcher = resolve(root, "launcher.bash");
  await mkdir(sourceRoot);
  await writeFile(launcher, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$DIM_QEMU_INPUT_SNAPSHOTS_JSON" >>"$DIM_TEST_LAUNCH_RECORD"
printf 'ready\\n'
[[ "$DIM_TEST_LAUNCHER_MODE" != exit ]] || exit 0
sleep 86400 &
sleeper=$!
trap 'kill "$sleeper" >/dev/null 2>&1 || true; exit 0' TERM INT
wait "$sleeper"
`);
  await chmod(launcher, 0o700);
  const stderr: Buffer[] = [];
  const watcher = watch(root);
  const child = spawn(process.execPath, [serviceScript], {
    env: {
      ...process.env,
      DIM_QEMU_LAUNCHER: launcher, DIM_QEMU_SERVICE_SOCKET: socketPath, DIM_QEMU_SOURCE_ROOT: sourceRoot,
      DIM_TEST_LAUNCH_RECORD: recordFile,
      DIM_TEST_LAUNCHER_MODE: mode
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const fixture = { process: child, recordFile, socketPath, sourceRoot };
  fixtures.push(fixture);
  await new Promise<void>((resolveReady, rejectReady) => {
    watcher.on("change", (_event, filename) => {
      if (filename?.toString() !== "service.pid") return;
      watcher.close();
      resolveReady();
    });
    child.once("exit", (code) => {
      watcher.close();
      rejectReady(new TypeError(`QEMU service exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
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

function http(fixture: ServiceFixture, spec: RequestSpec): Promise<HttpResult> {
  const body = spec.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(spec.body));
  const outgoing = request({
    socketPath: fixture.socketPath,
    method: spec.method,
    path: spec.path,
    headers: body.length === 0 ? undefined : { "content-length": body.length, "content-type": "application/json" }
  });
  const response = responseFrom(outgoing);
  outgoing.end(body);
  return response;
}

function incompleteRun(fixture: ServiceFixture): IncompleteRun {
  const body = Buffer.from(JSON.stringify({ inputs: [], mode: "run", verbose: false }));
  const outgoing = request({
    socketPath: fixture.socketPath,
    method: "POST",
    path: "/v1/run",
    headers: { "content-length": body.length, "content-type": "application/json", expect: "100-continue" }
  });
  const continued = new Promise<void>((resolveContinue, rejectContinue) => {
    outgoing.once("continue", resolveContinue);
    outgoing.once("error", rejectContinue);
  });
  const response = responseFrom(outgoing);
  outgoing.flushHeaders();
  return { continued, finish: () => outgoing.end(body), response };
}

function readEvents(fixture: ServiceFixture, marker?: string): Promise<string> {
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

async function stopService(fixture: ServiceFixture): Promise<void> {
  if (fixture.process.exitCode !== null || fixture.process.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => fixture.process.once("exit", () => resolveExit()));
  fixture.process.kill("SIGTERM");
  await exited;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => {
    if (error) rejectClose(error);
    else resolveClose();
  }));
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(stopService));
  await Promise.all(fixtureServers.splice(0).map(closeServer));
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QEMU service admission", () => {
  it("claims an incomplete request synchronously so a later request cannot become another run owner", async () => {
    // Given
    const fixture = await startService("exit");
    const firstRun = incompleteRun(fixture);
    await firstRun.continued;

    // When
    const later = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    if (later.status === 202) await readEvents(fixture);
    firstRun.finish();
    const first = await firstRun.response;
    if (first.status === 202) await readEvents(fixture);
    const records = await launchRecords(fixture);

    // Then
    expect.soft(later.status).toBe(409);
    expect.soft(first.status).toBe(202);
    expect(records).toHaveLength(1);
  });

  it("rejects duplicate names before resolving paths and releases the admission claim", async () => {
    // Given
    const fixture = await startService("exit");
    const valid = resolve(fixture.sourceRoot, "valid");
    await mkdir(valid);

    // When
    const rejected = await http(fixture, { body: { inputs: [
      { name: "duplicate", path: resolve(fixture.sourceRoot, "missing") },
      { name: "duplicate", path: valid }
    ] }, method: "POST", path: "/v1/run" });
    const accepted = await http(fixture, {
      body: { inputs: [{ name: "valid", path: valid }] }, method: "POST", path: "/v1/run"
    });
    if (accepted.status === 202) await readEvents(fixture);

    // Then
    expect.soft(rejected.status).toBe(400);
    expect.soft(rejected.body).toContain("duplicate input name");
    expect.soft(accepted.status).toBe(202);
    expect(await launchRecords(fixture)).toHaveLength(1);
  });

  it("passes immutable service-owned snapshots without dereferencing symlinks", async () => {
    // Given
    const fixture = await startService("hold");
    const input = resolve(fixture.sourceRoot, "input");
    await mkdir(input);
    await writeFile(resolve(input, "payload.txt"), "admitted\n");
    await symlink("payload.txt", resolve(input, "link"));

    // When
    const started = await http(fixture, {
      body: { inputs: [{ name: "fixture", path: input }] }, method: "POST", path: "/v1/run"
    });
    await readEvents(fixture, "ready\n");
    const records = await launchRecords(fixture);
    const passed = records[0]?.[0];
    if (passed === undefined) throw new TypeError("launcher did not receive an input");
    const moved = resolve(fixture.sourceRoot, "input-before-replacement");
    const replacement = resolve(fixture.sourceRoot, "replacement");
    await rename(input, moved);
    await mkdir(replacement);
    await writeFile(resolve(replacement, "payload.txt"), "replaced\n");
    await writeFile(resolve(replacement, "link"), "not-a-symlink\n");
    await symlink(replacement, input, "dir");
    const content = await readFile(resolve(passed.path, "payload.txt"), "utf8"), storageMode = (await lstat(resolve(passed.path, "../.."))).mode & 0o777;
    const link = await lstat(resolve(passed.path, "link"));
    const linkTarget = link.isSymbolicLink() ? await readlink(resolve(passed.path, "link")) : null;
    const cancelled = await http(fixture, { method: "DELETE", path: "/v1/run" });
    await readEvents(fixture);

    // Then
    expect.soft(started.status).toBe(202);
    expect.soft({ owned: passed.path.startsWith(`${resolve(fixture.socketPath, "../runs")}/`), mode: storageMode }).toEqual({ owned: true, mode: 0o700 });
    expect.soft(content).toBe("admitted\n");
    expect.soft({ symbolic: link.isSymbolicLink(), target: linkTarget }).toEqual({ symbolic: true, target: "payload.txt" });
    expect(cancelled.status).toBe(202);
  });

  it("releases the claim and launches no child when snapshot creation fails", async () => {
    // Given
    const fixture = await startService("exit");
    const unsupported = resolve(fixture.sourceRoot, "unsupported");
    const valid = resolve(fixture.sourceRoot, "valid");
    await mkdir(unsupported);
    await mkdir(valid);
    const special = createServer();
    fixtureServers.push(special);
    await new Promise<void>((resolveListen, rejectListen) => {
      special.once("error", rejectListen);
      special.listen(resolve(unsupported, "entry.sock"), resolveListen);
    });

    // When
    const rejected = await http(fixture, {
      body: { inputs: [{ name: "unsupported", path: unsupported }] }, method: "POST", path: "/v1/run"
    });
    if (rejected.status === 202) await readEvents(fixture);
    await closeServer(special);
    const accepted = await http(fixture, {
      body: { inputs: [{ name: "valid", path: valid }] }, method: "POST", path: "/v1/run"
    });
    if (accepted.status === 202) await readEvents(fixture);
    const records = await launchRecords(fixture);

    // Then
    expect.soft(rejected.status).toBe(400);
    expect.soft(accepted.status).toBe(202);
    expect(records).toHaveLength(1);
  });
});
