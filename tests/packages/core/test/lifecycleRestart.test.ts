import { describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/managed/src/lifecycleOptions.js";
import type { StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { restartWorkspace } from "../../../../core/packages/managed/src/workspaceTransitions.js";

describe("native workspace restart", () => {
  it("requires native control-plane configuration before state or runtime access", async () => {
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        return { command, args, stdout: "", stderr: "", exitCode: 0 };
      },
      async runStreaming(command, args) {
        calls.push([command, ...args]);
        return 0;
      }
    };
    const options = lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: "/state" });

    await expect(restartWorkspace(runner, options, "work-1"))
      .rejects.toThrow(/native control plane is not configured/);
    expect(calls).toEqual([]);
  });
});
