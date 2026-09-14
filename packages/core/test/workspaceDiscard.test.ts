import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { discardWorkspace } from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { workspaceContainerInspect, workspaceVolumeInspect } from "./workspaceOwnershipFixture.js";

const WORKSPACE = {
  schemaVersion: 5,
  name: "work-1",
  projectId: "project-id",
  projectName: "project",
  rootRepositoryAlias: "root",
  rootRef: "refs/heads/main",
  rootCommit: "a".repeat(40),
  rootSnapshotPath: "/tmp/dim-test-project-root",
  repositoryRefOverrides: {},
  repositorySnapshot: {
    root: {
      workspaceUrl: "http://dim-gitea:3000/dim-project/root.git",
      phase: "ready",
      root: true,
      requestedRef: "refs/heads/main",
      ref: "refs/heads/main",
      commit: "a".repeat(40)
    }
  },
  projectPath: "/workspace/project",
  phase: "ready",
  profiles: ["development"],
  composeProjectName: "dim-work-1",
  containerName: "dim-ws-work-1",
  networkName: "dim-control",
  dockerVolumeName: "dim-ws-work-1-docker",
  runtimeBackend: "sysbox",
  kvm: false,
  cpuCount: "2",
  memory: "4g",
  pidsLimit: "2048",
  routes: [],
  gitUserName: "Agent",
  gitUserEmail: "agent@example.invalid",
  gitBaseUrl: "http://dim-gitea:3000/dim-project",
  hostAliases: { "dim-gitea": ["172.20.0.2"] },
  projectManifestPath: "/run/dim/project.json",
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z"
} satisfies WorkspaceRecord;

const CONTAINER_ID = "c".repeat(64);

class DiscardRunner implements StreamingCommandRunner {
  readonly runCalls: string[][] = [];
  readonly streamingCalls: string[][] = [];

  constructor(
    private readonly teardownKind: "custom" | "compose" = "custom",
    private readonly teardownExitCode = 0
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.runCalls.push([command, ...args]);
    if (args[0] === "container" && args[1] === "inspect") {
      return {
        command,
        args,
        stdout: `${workspaceContainerInspect(WORKSPACE, { id: CONTAINER_ID })}\n`,
        stderr: "",
        exitCode: 0
      };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return {
        command,
        args,
        stdout: `${workspaceVolumeInspect(WORKSPACE)}\n`,
        stderr: "",
        exitCode: 0
      };
    }
    if (args.at(-2) === "-f") {
      const expectedFile = this.teardownKind === "custom" ? ".dim/teardown.sh" : ".dim/docker-compose.yml";
      return { command, args, stdout: "", stderr: "", exitCode: args.at(-1) === expectedFile ? 0 : 1 };
    }
    if (args[0] === "container" && args[1] === "rm") {
      return { command, args, stdout: WORKSPACE.containerName, stderr: "", exitCode: 0 };
    }
    if (args[0] === "volume" && args[1] === "rm") {
      return { command, args, stdout: WORKSPACE.dockerVolumeName, stderr: "", exitCode: 0 };
    }
    return { command, args, stdout: "", stderr: "unexpected command", exitCode: 1 };
  }

  async runStreaming(command: string, args: string[]): Promise<number> {
    this.streamingCalls.push([command, ...args]);
    return this.teardownExitCode;
  }
}

describe("workspace discard teardown intent", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-workspace-discard-"));
    WORKSPACE.rootSnapshotPath = join(root, "assets", "project-roots", "project-id", WORKSPACE.rootCommit);
    await mkdir(WORKSPACE.rootSnapshotPath, { recursive: true });
    await new LifecycleState(root).claimWorkspace(WORKSPACE);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes retained-volume intent to the custom Project teardown when keepVolume is true", async () => {
    // Given
    const runner = new DiscardRunner();
    const options = lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root });

    // When
    await discardWorkspace(runner, options, WORKSPACE.name, true);

    // Then
    expect(runner.streamingCalls).toHaveLength(1);
    expect(runner.streamingCalls[0]?.slice(-7)).toEqual([
      CONTAINER_ID,
      "env",
      "DIM_WORKSPACE_DISCARD_KEEP_VOLUME=1",
      "sh",
      `/run/dim/project-roots/${WORKSPACE.rootCommit}/.dim/teardown.sh`,
      "--profile",
      "development"
    ]);
  });

  it("passes destructive intent to the custom Project teardown by default", async () => {
    // Given
    const runner = new DiscardRunner();
    const options = lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root });

    // When
    await discardWorkspace(runner, options, WORKSPACE.name);

    // Then
    expect(runner.streamingCalls[0]?.slice(-7)).toEqual([
      CONTAINER_ID,
      "env",
      "DIM_WORKSPACE_DISCARD_KEEP_VOLUME=0",
      "sh",
      `/run/dim/project-roots/${WORKSPACE.rootCommit}/.dim/teardown.sh`,
      "--profile",
      "development"
    ]);
  });

  it("passes destructive intent to the custom Project teardown when keepVolume is false", async () => {
    // Given
    const runner = new DiscardRunner();
    const options = lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root });

    // When
    await discardWorkspace(runner, options, WORKSPACE.name, false);

    // Then
    expect(runner.streamingCalls[0]?.slice(-7)).toEqual([
      CONTAINER_ID,
      "env",
      "DIM_WORKSPACE_DISCARD_KEEP_VOLUME=0",
      "sh",
      `/run/dim/project-roots/${WORKSPACE.rootCommit}/.dim/teardown.sh`,
      "--profile",
      "development"
    ]);
  });

  it("keeps the outer Docker volume when keepVolume is true", async () => {
    // Given
    const runner = new DiscardRunner();
    const options = lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root });

    // When
    await discardWorkspace(runner, options, WORKSPACE.name, true);

    // Then
    expect(runner.runCalls).not.toContainEqual([
      "docker", "volume", "rm", WORKSPACE.dockerVolumeName
    ]);
  });

  it("removes the outer Docker volume when keepVolume is false", async () => {
    // Given
    const runner = new DiscardRunner();
    const options = lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root });

    // When
    await discardWorkspace(runner, options, WORKSPACE.name, false);

    // Then
    expect(runner.runCalls).toContainEqual([
      "docker", "volume", "rm", WORKSPACE.dockerVolumeName
    ]);
  });

  it.each(["custom", "compose"] as const)(
    "preserves every workspace asset when %s teardown exits nonzero",
    async (teardownKind) => {
      // Given
      const state = new LifecycleState(root);
      const workspaceGrant = await state.ensureWorkspaceGrant(WORKSPACE.name);
      const agentGrant = await state.ensureAgentGrant(WORKSPACE.name);
      const runner = new DiscardRunner(teardownKind, 17);
      const options = lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root });

      // When / Then
      await expect(discardWorkspace(runner, options, WORKSPACE.name)).rejects.toThrow(
        /project teardown exited with 17/
      );
      expect(runner.runCalls).not.toContainEqual([
        "docker", "container", "rm", "--force", WORKSPACE.containerName
      ]);
      expect(runner.runCalls).not.toContainEqual([
        "docker", "volume", "rm", WORKSPACE.dockerVolumeName
      ]);
      await expect(state.readWorkspace(WORKSPACE.name)).resolves.toEqual(WORKSPACE);
      await expect(state.authenticateWorkspaceGrant(workspaceGrant)).resolves.toEqual(WORKSPACE);
      await expect(state.authenticateAgentGrant(agentGrant)).resolves.toEqual(WORKSPACE);
    }
  );
});
