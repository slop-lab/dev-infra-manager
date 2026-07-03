import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentJob } from "../src/agentJob.js";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../src/types.js";

class FakeStreamingRunner implements StreamingCommandRunner {
  readonly commands: string[] = [];
  readonly streaming: string[] = [];

  constructor(private readonly failOn?: string) {}

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    this.commands.push(`${options.sudo ? "sudo " : ""}${command} ${args.join(" ")}`);
    if (this.failOn === command) {
      return { command, args, stdout: "", stderr: "injected failure", exitCode: 1 };
    }
    if (command === "mountpoint") {
      return { command, args, stdout: "", stderr: "", exitCode: 1 };
    }
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  }

  async runStreaming(command: string, args: string[], options: RunOptions = {}): Promise<number> {
    this.streaming.push(`${options.sudo ? "sudo " : ""}${command} ${args.join(" ")}`);
    return 0;
  }
}

describe("agent job orchestration", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-agent-job-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prepares, runs with timeout, and cleans up", async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      stateRoot: join(root, "state"),
      jobMountRoot: join(root, "mounts")
    });
    const runner = new FakeStreamingRunner();

    const exitCode = await runAgentJob(config, runner, {
      jobId: "job-1",
      profileName: "default",
      command: ["bash", "-lc", "echo ok"],
      sudo: true,
      keepDisk: false
    });

    expect(exitCode).toBe(0);
    expect(runner.commands.some((command) => command.startsWith("truncate "))).toBe(true);
    expect(runner.streaming[0]).toContain("sudo timeout 3600s docker run");
    expect(runner.commands.some((command) => command.includes("rm -rf"))).toBe(true);
  });

  it("cleans partial job state when prepare fails", async () => {
    const config = normalizeConfig({
      ...DEFAULT_CONFIG,
      stateRoot: join(root, "state"),
      jobMountRoot: join(root, "mounts")
    });
    const runner = new FakeStreamingRunner("mount");

    await expect(
      runAgentJob(config, runner, {
        jobId: "job-2",
        profileName: "default",
        command: ["bash"],
        sudo: true,
        keepDisk: false
      })
    ).rejects.toThrow(/Command failed/);
    expect(runner.commands.some((command) => command.includes("rm -rf"))).toBe(true);
  });
});
