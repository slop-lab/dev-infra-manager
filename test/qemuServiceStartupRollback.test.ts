import { spawn, type ChildProcess } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
  it("exits without residue while preserving a foreign socket that replaces the bound pathname", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-startup-rollback-test-"));
    roots.push(root);
    const sourceRoot = resolve(root, "source");
    const socketPath = resolve(root, "service.sock");
    const blocked = resolve(root, "publication-blocked");
    const release = resolve(root, "publication-release");
    const loader = resolve(root, "owner-loader.mjs");
    const ownerWrapper = resolve(root, "owner-wrapper.mjs");
    await mkdir(sourceRoot);
    await writeFile(loader, `import { pathToFileURL } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("qemu-service-owner.mjs") && !specifier.includes("?real")) {
    return { shortCircuit: true, url: pathToFileURL(process.env.DIM_TEST_OWNER_WRAPPER).href };
  }
  return nextResolve(specifier, context);
}
`);
    await writeFile(ownerWrapper, `import fs from "node:fs";
import * as owner from ${JSON.stringify(`${pathToFileURL(resolve(workspaceRoot, "project/.dim/qemu-service-owner.mjs")).href}?real`)};
export const captureSocketIdentity = owner.captureSocketIdentity;
export const createOwnerRecord = owner.createOwnerRecord;
export const removeIfOwned = owner.removeIfOwned;
export const restoreReplacedSocket = owner.restoreReplacedSocket;
export const safeguardReplacedSocket = owner.safeguardReplacedSocket;
export async function publishOwner() {
  await fs.promises.writeFile(process.env.DIM_TEST_PUBLICATION_BLOCKED, "blocked\\n");
  while (!fs.existsSync(process.env.DIM_TEST_PUBLICATION_RELEASE)) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  throw Object.assign(new Error("DIM_TEST_OWNER_PUBLICATION_FAILED"), { code: "EIO" });
}
`);
    await chmod(loader, 0o600);
    const child = spawn(process.execPath, ["--experimental-loader", loader, serviceScript], {
      env: { ...process.env, DIM_QEMU_LAUNCHER: "/bin/false", DIM_QEMU_SERVICE_SOCKET: socketPath,
        DIM_QEMU_SOURCE_ROOT: sourceRoot, DIM_TEST_OWNER_WRAPPER: ownerWrapper,
        DIM_TEST_PUBLICATION_BLOCKED: blocked, DIM_TEST_PUBLICATION_RELEASE: release },
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
    expect({ entries: await readdir(root), exitCode: child.exitCode, stderr: Buffer.concat(stderr).toString("utf8") }).toMatchObject({
      entries: expect.arrayContaining(["service.sock"]), exitCode: null,
    });
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));

    const entries = await readdir(root);
    expect.soft({ entries, exitCode: child.exitCode, exited, stderr: Buffer.concat(stderr).toString("utf8") }).toMatchObject({
      entries: expect.arrayContaining(["service.sock"]), exited: true,
    });
    expect.soft(child.exitCode).not.toBe(0);
    expect.soft(await exists(resolve(root, "service-owner.json"))).toBe(false);
    expect.soft(await exists(resolve(root, "runs"))).toBe(false);
    if (entries.includes("service.sock")) {
      const surviving = await lstat(socketPath, { bigint: true });
      expect({ device: surviving.dev, inode: surviving.ino }).toEqual({ device: foreignIdentity.dev, inode: foreignIdentity.ino });
    }
  });
});
