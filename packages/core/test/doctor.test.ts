import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeBackendChecks, sysboxExecutionCheck } from "../../../../core/packages/core/src/doctor.js";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import type { CommandResult, CommandRunner, RunOptions } from "../../../../core/packages/core/src/types.js";

class QueueRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; sudo: boolean }> = [];

  constructor(private readonly results: CommandResult[]) {}

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push({ command, args, sudo: options.sudo ?? false });
    const result = this.results.shift();
    if (!result) {
      throw new Error("No queued result");
    }
    return result;
  }
}

function result(exitCode: number, stderr = "", stdout = ""): CommandResult {
  return { command: "docker", args: [], stdout, stderr, exitCode };
}

describe("doctor checks", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((target) => rm(target, { recursive: true, force: true })));
  });

  it("checks actual Sysbox container execution", async () => {
    const runner = new QueueRunner([result(0)]);
    const check = await sysboxExecutionCheck(runner);

    expect(check).toEqual({
      name: "Sysbox container execution",
      ok: true,
      detail: "hello-world completed"
    });
    expect(runner.calls[0]?.args).toEqual(["run", "--rm", "--runtime=sysbox-runc", "--pull=missing", "hello-world:latest"]);
  });

  it("retries Sysbox execution with sudo after Docker permission errors", async () => {
    const runner = new QueueRunner([result(1, "permission denied"), result(0)]);
    const check = await sysboxExecutionCheck(runner);

    expect(check.ok).toBe(true);
    expect(runner.calls.map((call) => call.sudo)).toEqual([false, true]);
  });

  it("returns the first Docker error line for Sysbox execution failures", async () => {
    const runner = new QueueRunner([result(127, "docker: Error response from daemon: failed to register with sysbox-mgr\nRun 'docker run --help'")]);
    const check = await sysboxExecutionCheck(runner);

    expect(check).toEqual({
      name: "Sysbox container execution",
      ok: false,
      detail: "docker: Error response from daemon: failed to register with sysbox-mgr"
    });
  });

  it("checks Sysbox without making KVM a backend prerequisite", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-doctor-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "dim.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" }));
    const options = lifecycleOptionsForBackend("sysbox", { DIM_CONFIG_PATH: configPath });
    const runner = new QueueRunner([
      result(0, "", "sysbox-runc version"),
      result(0, "", "active"),
      result(0, "", '{"sysbox-runc":{}}'),
      result(0)
    ]);

    const checks = await runtimeBackendChecks(runner, "sysbox", options);
    expect(checks.map((check) => check.name)).toContain("Sysbox container execution");
    expect(checks.map((check) => check.name)).not.toContain("KVM device");
  });
});
