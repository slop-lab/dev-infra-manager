import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptions } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState, validateLifecycleName } from "../../../../core/packages/core/src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import {
  alignWorkspaceRoot,
  detectWorkspaceKvm,
  projectRuntimeManifest,
  resolveWorkspaceCapabilities,
  resolveRepositorySnapshot,
  resolveWorkspaceKvm,
  restartWorkspace,
  updateWorkspaceResources,
  validateRepositoryRefOverrides,
  validateWorkspaceProfiles,
  validateWorkspaceResources,
  waitForInnerDocker,
  workspaceContainerArgs
} from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { workspaceRuntimePlan } from "../../../../core/packages/core/src/runtimeBackends.js";
import { rootRepositorySnapshot } from "./lifecycleFixture.js";

describe("project and workspace lifecycle", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-lifecycle-"));
    await writeFile(join(root, "dim.json"), JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

it("reports stopped workspace state and entrypoint logs when inner Docker fails", async () => {
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command: string, args: string[], _options?: RunOptions): Promise<CommandResult> {
        calls.push([command, ...args]);
        if (args[0] === "exec") {
          return { command, args, stdout: "", stderr: "container is not running", exitCode: 1 };
        }
        if (args[0] === "inspect" && args[2] === "{{json .State}}") {
          return {
            command,
            args,
            stdout: JSON.stringify({ Running: false, Status: "exited" }),
            stderr: "",
            exitCode: 0
          };
        }
        if (args[0] === "inspect") {
          return {
            command,
            args,
            stdout: 'status=exited exitCode=1 oomKilled=false error=""\n',
            stderr: "",
            exitCode: 0
          };
        }
        return { command, args, stdout: "dockerd mount failure\n", stderr: "", exitCode: 0 };
      },
      async runStreaming(): Promise<number> {
        return 0;
      }
    };

    await expect(waitForInnerDocker(runner, "dim-ws-failed")).rejects.toThrow(
      /nested docker did not become ready[\s\S]*status=exited exitCode=1 oomKilled=false[\s\S]*dockerd mount failure/
    );
    expect(calls.filter(([, subcommand]) => subcommand === "exec")).toHaveLength(1);
    expect(calls.at(-1)).toEqual(["docker", "logs", "dim-ws-failed"]);
  });
});
