import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";
import { planSecretDeploy } from "../src/secretDeploy.js";

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
});
