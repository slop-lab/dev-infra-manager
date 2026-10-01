import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shutdownHost } from "../../../../core/packages/core/src/hostLifecycle.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { hostLifecycleOptions, workspaceRecord } from "./hostLifecycleFixture.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";

describe("host shutdown with interrupted discard", () => {
  let root = "";

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stops a running discarding workspace without scheduling it for resume", async () => {
    // Given
    root = await mkdtemp(join(tmpdir(), "dim-host-discarding-"));
    const record = workspaceRecord("discarding", "discarding");
    const state = new LifecycleState(root);
    await state.claimWorkspace(record);
    const runner = new DiscardingWorkspaceRunner(record);

    // When
    const stopped = await shutdownHost(runner, hostLifecycleOptions(root));

    // Then
    expect(stopped.phase).toBe("stopped");
    expect(stopped.resumeWorkspaces).toEqual([]);
    expect(runner.calls).toContainEqual(["docker", "stop", "workspace-container-id"]);
    await expect(state.readWorkspace(record.name)).resolves.toMatchObject({ phase: "discarding" });
  });
});

class DiscardingWorkspaceRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];

  constructor(private readonly record: ReturnType<typeof workspaceRecord>) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (args[0] === "container" && args[1] === "ls") {
      return { command, args, stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === this.record.containerName) {
      return { command, args, stdout: `${workspaceContainerInspect(this.record)}\n`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return { command, args, stdout: "", stderr: `No such container: ${args[2]}`, exitCode: 1 };
    }
    if (args[0] === "stop") {
      return { command, args, stdout: `${args[1]}\n`, stderr: "", exitCode: 0 };
    }
    return { command, args, stdout: "", stderr: "unexpected command", exitCode: 1 };
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}
