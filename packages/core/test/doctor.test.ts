import { describe, expect, it } from "vitest";
import { runDoctor, sysboxExecutionCheck } from "../src/doctor.js";
import { lifecycleOptions } from "../src/lifecycleOptions.js";
import type { CommandResult, CommandRunner, RunOptions } from "../src/types.js";

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

  it("runs gVisor checks without Sysbox service checks", async () => {
    const options = lifecycleOptions({ DIM_WORKSPACE_BACKEND: "gvisor" });
    const runner = new QueueRunner([
      result(0, "", "v22.0.0"),
      result(0, "", "10.0.0"),
      result(0, "", "just 1.0.0"),
      result(0, "", "git version 2.0.0"),
      result(0, "", "Docker version 1.0.0"),
      result(0, "", "29.0.0"),
      result(0, "", "runsc version release"),
      result(0, "", '{"runsc":{}}'),
      result(0)
    ]);

    const checks = await runDoctor(runner, "gvisor", options);
    expect(checks.map((check) => check.name)).toContain("gVisor container execution");
    expect(checks.map((check) => check.name)).not.toContain("Sysbox service");
  });
});
