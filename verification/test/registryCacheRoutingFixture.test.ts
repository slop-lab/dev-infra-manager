import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createTemporaryRootTracker } from "./registryCacheRouting.fixture.js";

const verificationRoot = resolve(import.meta.dirname, "..");
const fixtureScript = resolve(verificationRoot, "scripts/registry-cache-evidence.mjs");
const temporaryRoots = createTemporaryRootTracker();
type FixtureProcess = ChildProcessByStdio<null, Readable, Readable>;
const fixtureProcesses: FixtureProcess[] = [];

async function stopFixture(child: FixtureProcess): Promise<void> {
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  await exited;
}

afterEach(async () => {
  await Promise.all(fixtureProcesses.splice(0).map(async (child) => {
    if (child.exitCode === null) await stopFixture(child);
  }));
  await temporaryRoots.cleanup();
});

describe("registry cache routing fixture integration seam", () => {
  it("writes readiness metadata after listening on an explicit reachable IPv4 bind address", async () => {
    // Given
    const root = await temporaryRoots.create();
    const readinessFile = resolve(root, "ready.json");
    const child = spawn(process.execPath, [
      fixtureScript,
      "--run-id", "routing-test",
      "--route", "cold",
      "--evidence-file", resolve(root, "evidence.jsonl"),
      "--ready-file", readinessFile,
      "--bind-address", "127.0.0.1"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    fixtureProcesses.push(child);
    const lines = createInterface({ input: child.stdout });

    // When
    const stdoutLine = await new Promise<string>((resolveLine) => lines.once("line", resolveLine));
    lines.close();
    const stdoutMetadata: unknown = JSON.parse(stdoutLine);
    const readinessMetadata: unknown = JSON.parse(await readFile(readinessFile, "utf8"));

    // Then
    expect(readinessMetadata).toEqual(stdoutMetadata);
    expect(readinessMetadata).toMatchObject({
      event_kind: "registry-cache-fixture-ready",
      host: "127.0.0.1",
      schema_version: 1
    });
  });

  it.each(["fixture.internal", "127.0.0.1:5000", "300.1.1.1", "0.0.0.0"])(
    "rejects unsafe bind address %s",
    async (bindAddress) => {
      // Given
      const root = await temporaryRoots.create();

      // When
      const result = spawnSync(process.execPath, [
        fixtureScript,
        "--run-id", "routing-test",
        "--route", "cold",
        "--evidence-file", resolve(root, "evidence.jsonl"),
        "--bind-address", bindAddress
      ], { encoding: "utf8", timeout: 1_000 });

      // Then
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--bind-address must be an IPv4 address");
    }
  );
});
