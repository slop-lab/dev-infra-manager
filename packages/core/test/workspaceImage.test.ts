import { describe, expect, it } from "vitest";
import { UserError } from "../../../../core/packages/core/src/errors.js";
import { inspectWorkspaceImage } from "../../../../core/packages/core/src/index.js";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import type { CommandResult, CommandRunner, RunOptions } from "../../../../core/packages/core/src/types.js";

class InspectRunner implements CommandRunner {
  readonly calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];

  constructor(private readonly result: CommandResult) {}

  async run(command: string, args: string[], _options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push({ command, args });
    return this.result;
  }
}

function commandResult(exitCode: number, stdout = "", stderr = ""): CommandResult {
  return { command: "docker", args: [], stdout, stderr, exitCode };
}

describe("workspace image inspection", () => {
  const imageId = `sha256:${"a".repeat(64)}`;
  const options = lifecycleOptionsForBackend("sysbox", {
    DIM_WORKSPACE_IMAGE: "example/workspace:tested"
  });

  it("returns the image ID when the configured image exists", async () => {
    const runner = new InspectRunner(commandResult(0, `${imageId}\n`));

    const status = await inspectWorkspaceImage(runner, "sysbox", options);

    expect(status).toEqual({ status: "ready", imageId });
    expect(runner.calls).toEqual([{
      command: "docker",
      args: ["image", "inspect", "--format", "{{.Id}}", "example/workspace:tested"]
    }]);
  });

  it.each([
    "sha256:abc123",
    `sha256:${"A".repeat(64)}`,
    `md5:${"a".repeat(64)}`,
    `${imageId} extra`,
    `${imageId}\n${imageId}`,
  ])("rejects malformed successful Docker image ID %j", async (stdout) => {
    const runner = new InspectRunner(commandResult(0, stdout));

    const inspection = inspectWorkspaceImage(runner, "sysbox", options);

    await expect(inspection).rejects.toBeInstanceOf(UserError);
    await expect(inspection).rejects.toThrow(/invalid image ID.*\^sha256:\[0-9a-f\]\{64\}\$/);
  });

  it("returns missing for Docker's image-not-found result", async () => {
    const runner = new InspectRunner(commandResult(
      1,
      "",
      "Error response from daemon: No such image: example/workspace:tested\n"
    ));

    const status = await inspectWorkspaceImage(runner, "sysbox", options);

    expect(status).toEqual({ status: "missing" });
  });

  it("surfaces other inspection failures as user errors", async () => {
    const runner = new InspectRunner(commandResult(1, "", "permission denied\n"));

    const inspection = inspectWorkspaceImage(runner, "sysbox", options);

    await expect(inspection).rejects.toBeInstanceOf(UserError);
    await expect(inspection).rejects.toThrow("failed to inspect workspace image 'example/workspace:tested': permission denied");
  });
});
