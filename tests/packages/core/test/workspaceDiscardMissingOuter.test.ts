import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { workspaceAgentIdentity, workspaceAgentNetworkLabels } from "../../../../core/packages/core/src/workspaceAgentRuntime.js";
import { discardWorkspace } from "../../../../core/packages/core/src/workspaceDiscard.js";
import { nativeWorkspaceFixture } from "./nativeLifecycleFixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("converges recommended discard when the outer container is already absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-discard-missing-outer-"));
  roots.push(root);
  const record = fixture();
  const state = new LifecycleState(root);
  await state.claimWorkspace(record);
  const identity = workspaceAgentIdentity(record);
  const calls: string[][] = [];
  const runner: StreamingCommandRunner = {
    async run(command, args): Promise<CommandResult> {
      calls.push([command, ...args]);
      if (args[0] === "container" && args[1] === "inspect") return missing(command, args, "container", args[2] ?? "");
      if (args[0] === "volume" && args[1] === "inspect") return missing(command, args, "volume", args[2] ?? "");
      if (args[0] === "network" && args[1] === "inspect") {
        return result(command, args, JSON.stringify(Object.fromEntries(workspaceAgentNetworkLabels(record)
          .map((value) => value.split("=", 2)))));
      }
      if (args[0] === "network" && args[1] === "rm") return result(command, args);
      return result(command, args);
    },
    async runStreaming(): Promise<number> { return 0; }
  };

    await discardWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root,
      DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: join(root, "native.json") }), record.name);

  await expect(state.readWorkspace(record.name)).rejects.toThrow(/not found/);
  expect(calls).not.toContainEqual([
    "docker", "network", "disconnect", "--force", identity.networkName, record.containerName
  ]);
  expect(calls).toContainEqual(["docker", "network", "rm", identity.networkName]);
});

function fixture(): WorkspaceRecord {
  return nativeWorkspaceFixture({ rootCommit: "b".repeat(40), environment: "recommended", gitUserName: "Agent",
    gitUserEmail: "agent@example.invalid", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z" });
}

function result(command: string, args: string[], stdout = ""): CommandResult {
  return { command, args, stdout, stderr: "", exitCode: 0 };
}

function missing(command: string, args: string[], kind: string, name: string): CommandResult {
  return { command, args, stdout: "", stderr: `Error: No such ${kind}: ${name}`, exitCode: 1 };
}
