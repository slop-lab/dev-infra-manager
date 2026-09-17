import { spawn, type ChildProcess } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnPreloadScript } from "./qemuServiceFixtureScripts.js";
import { waitForObservation } from "./qemuServiceTestSupport.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const serviceScript = resolve(workspaceRoot, "project/.dim/qemu-service.mjs");
const roots: string[] = [];
const processes: ChildProcess[] = [];
const servers: Server[] = [];

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function waitForExit(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise<boolean>((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 1_000)),
  ]);
}

function status(socketPath: string, method: string): Promise<number> {
  return new Promise((resolveStatus, rejectStatus) => {
    const outgoing = request({ socketPath, method, path: method === "GET" ? "/v1/status" : "/v1/run" }, (incoming) => {
      incoming.resume();
      incoming.once("end", () => resolveStatus(incoming.statusCode ?? 0));
    });
    outgoing.once("error", rejectStatus);
    outgoing.end(method === "POST" ? JSON.stringify({ inputs: [], mode: "run" }) : undefined);
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => {
    if (!server.listening) return resolveClose();
    server.close(() => resolveClose());
  })));
  await Promise.all(processes.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("QEMU service startup rollback", () => {
  it("rolls back a server error after listen while initialization remains asynchronous", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-initialization-error-test-"));
    roots.push(root);
    await chmod(root, 0o755);
    const sourceRoot = resolve(root, "source");
    const socketPath = resolve(root, "service.sock");
    const preload = resolve(root, "initialization-error-preload.mjs");
    const errorRecord = resolve(root, "initialization-errors.record");
    const closeRecord = resolve(root, "server-close.record");
    await mkdir(sourceRoot);
    await writeFile(preload, spawnPreloadScript());
    const child = spawn(process.execPath, ["--import", preload, serviceScript], {
      env: {
        ...process.env,
        DIM_QEMU_LAUNCHER: "/bin/false",
        DIM_QEMU_SERVICE_SOCKET: socketPath,
        DIM_QEMU_SOURCE_ROOT: sourceRoot,
        DIM_TEST_ERROR_AFTER_SOCKET_IDENTITY: "1",
        DIM_TEST_ERROR_DURING_ROLLBACK: "1",
        DIM_TEST_INITIALIZATION_ERROR_RECORD: errorRecord,
        DIM_TEST_SERVER_CLOSE_RECORD: closeRecord,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    processes.push(child);

    // When
    const exited = await waitForExit(child);

    // Then
    const entries = await readdir(root);
    expect.soft(exited, "initialization server error must produce bounded exit").toBe(true);
    expect.soft(child.exitCode).toBe(1);
    expect.soft(Buffer.concat(stderr).toString("utf8")).toContain("DIM_TEST_ERROR_AFTER_SOCKET_IDENTITY");
    expect.soft(await readFile(errorRecord, "utf8")).toBe("after-identity\nduring-rollback\n");
    expect.soft(await readFile(closeRecord, "utf8")).toBe("close\n");
    expect.soft(entries).toEqual([
      "initialization-error-preload.mjs", "initialization-errors.record", "server-close.record", "source",
    ]);
    expect.soft(await exists(socketPath)).toBe(false);
    expect.soft(await exists(resolve(root, ".service.sock.lease"))).toBe(false);
    expect.soft(await exists(resolve(root, "service-owner.json"))).toBe(false);
    expect(await exists(resolve(root, "runs"))).toBe(false);
  });

  it("rejects a listen error and removes only the prepared startup filesystem", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-listen-rollback-test-"));
    roots.push(root);
    await chmod(root, 0o755);
    const sourceRoot = resolve(root, "source");
    const socketPath = resolve(root, "service.sock");
    const preload = resolve(root, "listen-failure-preload.mjs");
    await mkdir(sourceRoot);
    await writeFile(preload, spawnPreloadScript());
    const child = spawn(process.execPath, ["--import", preload, serviceScript], {
      env: {
        ...process.env,
        DIM_QEMU_LAUNCHER: "/bin/false",
        DIM_QEMU_SERVICE_SOCKET: socketPath,
        DIM_QEMU_SOURCE_ROOT: sourceRoot,
        DIM_TEST_STARTUP_LISTEN_FAILURE: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    processes.push(child);

    // When
    const exited = await waitForExit(child);

    // Then
    const entries = await readdir(root);
    expect.soft(exited, "startup listen failure must produce bounded exit").toBe(true);
    expect.soft(child.exitCode).toBe(1);
    expect.soft(Buffer.concat(stderr).toString("utf8")).toContain("DIM_TEST_STARTUP_LISTEN_FAILURE");
    expect.soft(entries).toEqual(["listen-failure-preload.mjs", "source"]);
    expect.soft(await exists(socketPath)).toBe(false);
    expect.soft(await exists(resolve(root, ".service.sock.lease"))).toBe(false);
    expect.soft(await exists(resolve(root, "service-owner.json"))).toBe(false);
    expect(await exists(resolve(root, "runs"))).toBe(false);
  });

  it("exits without residue while preserving a foreign socket that replaces the bound pathname", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-startup-rollback-test-")); await chmod(root, 0o755);
    roots.push(root);
    const sourceRoot = resolve(root, "source");
    const runsRoot = resolve(root, "runs");
    const runSentinel = resolve(runsRoot, "existing-run");
    const socketPath = resolve(root, "service.sock");
    const blocked = resolve(root, "publication-blocked");
    const release = resolve(root, "publication-release");
    const loader = resolve(root, "owner-loader.mjs");
    const ownerWrapper = resolve(root, "owner-wrapper.mjs");
    await Promise.all([mkdir(sourceRoot), mkdir(runsRoot)]);
    await writeFile(runSentinel, "existing run\n");
    await writeFile(loader, `import { pathToFileURL } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("qemu-service-artifacts.mjs") && !specifier.includes("?real")) {
    return { shortCircuit: true, url: pathToFileURL(process.env.DIM_TEST_OWNER_WRAPPER).href };
  }
  return nextResolve(specifier, context);
}
`);
    await writeFile(ownerWrapper, `import fs from "node:fs";
import * as artifacts from ${JSON.stringify(`${pathToFileURL(resolve(workspaceRoot, "project/.dim/qemu-service-artifacts.mjs")).href}?real`)};
export const captureSocketIdentity = artifacts.captureSocketIdentity;
export const createSocketLease = artifacts.createSocketLease;
export const identity = artifacts.identity;
export const pathState = artifacts.pathState;
export const requireSocketLease = artifacts.requireSocketLease;
export const removeOwnedArtifacts = artifacts.removeOwnedArtifacts;
export const restoreReplacedSocket = artifacts.restoreReplacedSocket;
export const restoreSocketFromLease = artifacts.restoreSocketFromLease;
export const sameIdentity = artifacts.sameIdentity;
export const safeguardReplacedSocket = artifacts.safeguardReplacedSocket;
export const socketLeasePath = artifacts.socketLeasePath;
export async function publishOwner() {
  await fs.promises.writeFile(process.env.DIM_TEST_PUBLICATION_BLOCKED, "blocked\\n");
  if (!fs.existsSync(process.env.DIM_TEST_PUBLICATION_RELEASE)) await new Promise((resolveRelease) => {
    const watcher=fs.watch(process.env.DIM_TEST_ROOT,(_event,name)=>{if(name==="publication-release"){watcher.close();resolveRelease()}});
  });
  throw Object.assign(new Error("DIM_TEST_OWNER_PUBLICATION_FAILED"), { code: "EIO" });
}
`);
    await chmod(loader, 0o600);
    const child = spawn(process.execPath, ["--experimental-loader", loader, serviceScript], {
      env: { ...process.env, DIM_QEMU_LAUNCHER: "/bin/false", DIM_QEMU_SERVICE_SOCKET: socketPath,
        DIM_QEMU_SOURCE_ROOT: sourceRoot, DIM_TEST_OWNER_WRAPPER: ownerWrapper,
        DIM_TEST_PUBLICATION_BLOCKED: blocked, DIM_TEST_PUBLICATION_RELEASE: release, DIM_TEST_ROOT: root },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    processes.push(child);
    await Promise.race([
      waitForObservation(async () => (await exists(blocked)) ? true : undefined),
      new Promise<never>((_resolveExit, rejectExit) => child.once("exit", (code) => {
        rejectExit(new TypeError(`service exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
      })),
    ]);
    const blockedEntries = await readdir(root);
    const [blockedSocket, blockedLease] = await Promise.all([
      lstat(socketPath, { bigint: true }), lstat(resolve(root, ".service.sock.lease"), { bigint: true }),
    ]);
    expect({ entries: blockedEntries, exitCode: child.exitCode, stderr: Buffer.concat(stderr).toString("utf8") }).toMatchObject({
      entries: expect.arrayContaining([".service.sock.lease", "service.sock"]), exitCode: null,
    });
    expect.soft({ device: blockedLease.dev, inode: blockedLease.ino })
      .toEqual({ device: blockedSocket.dev, inode: blockedSocket.ino });
    expect.soft(await status(socketPath, "GET")).toBe(503);
    expect.soft(await status(socketPath, "POST")).toBe(503);
    expect.soft(await readFile(runSentinel, "utf8")).toBe("existing run\n");
    await rm(socketPath);
    const foreign = createServer();
    servers.push(foreign);
    const foreignPath = resolve(root, "foreign.sock");
    await new Promise<void>((resolveListen, rejectListen) => {
      foreign.once("error", rejectListen);
      foreign.listen(foreignPath, resolveListen);
    });
    await link(foreignPath, socketPath);
    const foreignIdentity = await lstat(foreignPath, { bigint: true });

    await writeFile(release, "release\n");
    const exited = await waitForExit(child);

    const entries = await readdir(root);
    expect.soft({ entries, exitCode: child.exitCode, exited, stderr: Buffer.concat(stderr).toString("utf8") }).toMatchObject({
      entries: expect.arrayContaining(["service.sock"]), exited: true,
    });
    expect.soft(child.exitCode).not.toBe(0);
    expect.soft(await exists(resolve(root, "service-owner.json"))).toBe(false);
    expect.soft(await readdir(runsRoot)).toEqual(["existing-run"]);
    expect.soft(await readFile(runSentinel, "utf8")).toBe("existing run\n");
    expect.soft(await exists(resolve(root, ".service.sock.lease"))).toBe(false);
    if (entries.includes("service.sock")) {
      const surviving = await lstat(socketPath, { bigint: true });
      expect({ device: surviving.dev, inode: surviving.ino }).toEqual({ device: foreignIdentity.dev, inode: foreignIdentity.ino });
    }
  });
});
