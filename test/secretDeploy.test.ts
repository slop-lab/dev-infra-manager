import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";
import { deploySecretRuntime, planSecretDeploy } from "../src/secretDeploy.js";
import type { CommandResult, CommandRunner, RunOptions } from "../src/types.js";

class RunFailureRunner implements CommandRunner {
  readonly commands: Array<{ command: string; args: string[]; sudo: boolean }> = [];

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    this.commands.push({ command, args, sudo: options.sudo ?? false });
    const exitCode = command === "docker" && args[0] === "run" ? 1 : 0;
    return { command, args, stdout: "", stderr: exitCode === 0 ? "" : "runtime create failed", exitCode };
  }
}

describe("secret runtime deploy planning", () => {
  it("deploys only from the configured approved ref", () => {
    const config = normalizeConfig(DEFAULT_CONFIG);
    const commands = planSecretDeploy(config, "/tmp/worktree");

    expect(commands[0]).toMatchObject({
      command: "git",
      args: expect.arrayContaining(["worktree", "add", "--detach", "/tmp/worktree", "refs/heads/main"])
    });
    expect(commands[1]).toMatchObject({
      command: "docker",
      args: expect.arrayContaining(["build", "--pull", "--tag", "dev-infra-secret-runtime:latest"])
    });
    expect(commands[2]?.allowFailure).toBe(true);
    expect(commands[3]).toMatchObject({
      command: "docker",
      args: expect.arrayContaining(["run", "--detach", "--name", "dev-infra-secret-runtime"])
    });
  });

  it("removes a container object left by a failed docker run", async () => {
    const config = normalizeConfig(DEFAULT_CONFIG);
    const runner = new RunFailureRunner();

    await expect(deploySecretRuntime(config, runner, false)).rejects.toThrow("runtime create failed");

    const runIndex = runner.commands.findIndex(({ command, args }) => command === "docker" && args[0] === "run");
    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(runner.commands[runIndex + 1]).toEqual({
      command: "docker",
      args: ["rm", "--force", "dev-infra-secret-runtime"],
      sudo: true
    });
  });
});
