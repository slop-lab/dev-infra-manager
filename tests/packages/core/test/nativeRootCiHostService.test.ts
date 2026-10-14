import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNativeRootCiHost } from "../../../../core/packages/core/src/nativeRootCiHostService.js";
import { NativeRootCiHostJournal } from "../../../../core/packages/core/src/nativeRootCiHostJournal.js";
import { tryAcquireKernelGuard } from "../../../../core/packages/core/src/lifecycleLockGuard.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("native root CI installed host service", () => {
  it("refuses an unregistered Sysbox runtime before contacting either service", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-root-host-service-"));
    roots.push(root);
    const configPath = join(root, "host.json");
    await writeFile(configPath, JSON.stringify(config(root)), { mode: 0o600 });
    await chmod(configPath, 0o600);
    const runner = new RuntimeRunner("{\"runc\":{}}");

    // When
    const result = runNativeRootCiHost(configPath, AbortSignal.timeout(1_000), options(root), runner);

    // Then
    await expect(result).rejects.toThrow(/sysbox-runc.*required/);
    expect(runner.calls).toEqual([["docker", "info", "--format", "{{json .Runtimes}}"]]);
  });

  it("requires the installed host mirror provider before locking capacity", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-root-host-mirror-"));
    roots.push(root);
    const configPath = join(root, "host.json");
    await writeFile(configPath, JSON.stringify(config(root)), { mode: 0o600 });
    await chmod(configPath, 0o600);
    const runner = new RuntimeRunner("{\"sysbox-runc\":{}}");

    // When
    const running = runNativeRootCiHost(configPath, AbortSignal.timeout(1_000),
      lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), runner);

    // Then
    await expect(running).rejects.toThrow(/requires one enabled host mirror provider/);
    expect(runner.calls).toEqual([["docker", "info", "--format", "{{json .Runtimes}}"]]);
  });

  it("locks every configured capacity before any worker can attest or claim", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-root-host-locks-"));
    roots.push(root);
    const configPath = join(root, "host.json");
    await writeFile(configPath, JSON.stringify(config(root)), { mode: 0o600 });
    await chmod(configPath, 0o600);
    const backupPath = join(root, "state", "secondary.json");
    await new NativeRootCiHostJournal(backupPath).prepare();
    const guard = await tryAcquireKernelGuard(`${backupPath}.guard`);
    if (guard === undefined) throw new TypeError("test capacity guard was not acquired");
    const runner = new RuntimeRunner("{\"sysbox-runc\":{}}");

    // When
    const running = runNativeRootCiHost(configPath, AbortSignal.timeout(1_000), options(root), runner);

    // Then
    try { await expect(running).rejects.toThrow(/already served/); }
    finally { await guard.release(); }
    expect(runner.calls[0]).toEqual(["docker", "info", "--format", "{{json .Runtimes}}"]);
    expect(runner.calls).toContainEqual(expect.arrayContaining(["docker", "network", "create"]));
  });
});

function config(root: string): object {
  return { schemaVersion: 1, hostId: "host-a", generationId: "a".repeat(64),
    stateDirectory: join(root, "state"), gitExecutable: "/usr/bin/git",
    ordinaryCi: { transport: "loopback-http", endpoint: "http://127.0.0.1:1", serviceId: "ordinary-main",
      credential: { username: "host-a", password: Buffer.alloc(32, 1).toString("base64url") } },
    nativeGit: { transport: "loopback-http", endpoint: "http://127.0.0.1:2", serviceId: "native-main" },
    capacities: ["primary", "secondary"] };
}

function options(root: string) {
  return { ...lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), hostMirrorProvider: {
    dockerImage: `registry@sha256:${"1".repeat(64)}`,
    aptImage: `apt@sha256:${"2".repeat(64)}`
  } };
}

class RuntimeRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];
  constructor(private readonly runtimes: string) {}
  run(command: string, args: string[], _options?: RunOptions): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (args[0] === "info") return Promise.resolve({ command, args, stdout: this.runtimes, stderr: "", exitCode: 0 });
    if (args[0] === "network" && args[1] === "inspect") return Promise.resolve({ command, args, stdout: "",
      stderr: "Error response from daemon: network dim-control not found", exitCode: 1 });
    if (args[0] === "volume" && args[1] === "inspect") return Promise.resolve({ command, args, stdout: "",
      stderr: "Error response from daemon: get dim-registry-cache-data: no such volume", exitCode: 1 });
    if (args[0] === "container" && args[1] === "inspect") return Promise.resolve({ command, args, stdout: "",
      stderr: "Error response from daemon: No such container: dim-registry-cache", exitCode: 1 });
    return Promise.resolve({ command, args, stdout: "", stderr: "", exitCode: 0 });
  }
  runStreaming(): Promise<number> { return Promise.resolve(0); }
}
