import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ordinaryBundleConfig } from "./nativeOrdinaryBundleConfigFixture.js";

const run = promisify(execFile);
const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const packageRoot = join(workspaceRoot, "core/packages/core");
const fixture = join(import.meta.dirname, "fixtures/nativeOrdinaryIdleProcess.mjs");
const roots: string[] = [];

beforeAll(async () => {
  await run("pnpm", ["run", "build"], { cwd: packageRoot });
});

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ordinary CI idle bundle service file modes", () => {
  it("creates private SQLite files and a read-only marker under umask 0022", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-idle-modes-"));
    roots.push(root);
    const config = join(root, "service.json");
    const readiness = join(root, "readiness.token");
    const activation = join(root, "activation.token");
    await Promise.all([
      writeFile(config, JSON.stringify(ordinaryBundleConfig())),
      writeFile(readiness, `${Buffer.alloc(32, 41).toString("base64url")}\n`),
      writeFile(activation, `${Buffer.alloc(32, 42).toString("base64url")}\n`)
    ]);

    // When
    const child = execFile(process.execPath, [
      fixture, config, join(root, "state"), readiness, activation, "a".repeat(64)
    ]);
    await serviceReady(child);

    // Then
    try {
      const stateDirectory = join(root, "state");
      const entries = await readdir(stateDirectory);
      const serviceUid = process.geteuid?.();
      if (serviceUid === undefined) throw new TypeError("ordinary service tests require a POSIX effective uid");
      await expect(Promise.all(entries.map(async (entry) => {
        const metadata = await stat(join(stateDirectory, entry));
        return { entry, mode: metadata.mode & 0o777, uid: metadata.uid };
      }))).resolves.toEqual(expect.arrayContaining([
        { entry: "ordinary-ci.sqlite3", mode: 0o600, uid: serviceUid },
        { entry: "ordinary-ci.sqlite3-shm", mode: 0o600, uid: serviceUid },
        { entry: "ordinary-ci.sqlite3-wal", mode: 0o600, uid: serviceUid },
        { entry: "state-format.json", mode: 0o444, uid: serviceUid }
      ]));
    } finally {
      await stopService(child);
    }
  });
});

async function serviceReady(child: ReturnType<typeof execFile>): Promise<void> {
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout === null || stderr === null) throw new TypeError("idle process pipes are unavailable");
  let errors = "";
  stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
  await new Promise<void>((resolveReady, rejectReady) => {
    stdout.setEncoding("utf8").once("data", () => resolveReady());
    child.once("error", rejectReady);
    child.once("exit", (code) => rejectReady(new Error(`idle process exited ${String(code)}: ${errors}`)));
  });
}

async function stopService(child: ReturnType<typeof execFile>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((resolveExit, rejectExit) => {
    child.once("exit", (code, signal) => code === 0 || signal === "SIGTERM"
      ? resolveExit()
      : rejectExit(new Error(`idle process stopped with ${String(code)} ${String(signal)}`)));
    child.once("error", rejectExit);
  });
  child.kill("SIGTERM");
  await exit;
}
