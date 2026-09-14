import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { discardWorkspace } from "../../../../core/packages/core/src/workspaceLifecycle.js";
import {
  workspaceContainerLabels,
  workspaceVolumeLabels
} from "../../../../core/packages/core/src/workspaceResourceOwnership.js";

const CONTAINER_ID = "a".repeat(64);
const IDENTITY = {
  name: "work-1",
  projectId: "project-id",
  projectName: "project",
  rootRepositoryAlias: "root",
  runtimeBackend: "sysbox",
  containerName: "dim-ws-work-1",
  dockerVolumeName: "dim-ws-work-1-docker"
} as const;
const CONTAINER_LABELS = workspaceContainerLabels(IDENTITY).map(labelValue);
const VOLUME_LABELS = workspaceVolumeLabels(IDENTITY).map(labelValue);

type RunnerConfig = {
  readonly containerInspect?: string;
  readonly volumeInspect?: string;
  readonly volumeInspects?: readonly string[];
  readonly containerInspectError?: string;
  readonly volumeInspectError?: string;
  readonly containerRemoveError?: string;
  readonly volumeRemoveError?: string;
};

class OwnershipRunner implements StreamingCommandRunner {
  readonly runCalls: string[][] = [];
  readonly streamingCalls: string[][] = [];
  private volumeInspection = 0;

  constructor(private readonly config: RunnerConfig = {}) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.runCalls.push([command, ...args]);
    if (args[0] === "container" && args[1] === "inspect") {
      const stderr = this.config.containerInspectError ?? "";
      const stdout = this.config.containerInspect ?? [CONTAINER_ID, "true", ...CONTAINER_LABELS, "7"].join("|");
      return { command, args, stdout, stderr, exitCode: stderr ? 1 : 0 };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const stderr = this.config.volumeInspectError ?? "";
      const stdout = this.config.volumeInspects?.[this.volumeInspection]
        ?? this.config.volumeInspect
        ?? ["dim-ws-work-1-docker", ...VOLUME_LABELS].join("|");
      this.volumeInspection += 1;
      return { command, args, stdout, stderr, exitCode: stderr ? 1 : 0 };
    }
    if (args.at(-2) === "-f") {
      return { command, args, stdout: "", stderr: "", exitCode: args.at(-1) === ".dim/teardown.sh" ? 0 : 1 };
    }
    if (args[0] === "container" && args[1] === "rm") {
      const stderr = this.config.containerRemoveError ?? "";
      return { command, args, stdout: "", stderr, exitCode: stderr ? 1 : 0 };
    }
    if (args[0] === "volume" && args[1] === "rm") {
      const stderr = this.config.volumeRemoveError ?? "";
      return { command, args, stdout: "", stderr, exitCode: stderr ? 1 : 0 };
    }
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  }

  async runStreaming(command: string, args: string[]): Promise<number> {
    this.streamingCalls.push([command, ...args]);
    return 0;
  }
}

describe("workspace discard ownership", () => {
  let root = "";
  let workspace: WorkspaceRecord;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-workspace-discard-ownership-"));
    workspace = workspaceRecord(join(root, "project-root"));
    await mkdir(workspace.rootSnapshotPath, { recursive: true });
    await new LifecycleState(root).claimWorkspace(workspace);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["foreign", [CONTAINER_ID, "true", "false", ...CONTAINER_LABELS.slice(1), "7"].join("|")],
    ["partial", [CONTAINER_ID, "true", ...CONTAINER_LABELS.slice(0, -1), "7"].join("|")],
    ["mismatched", [CONTAINER_ID, "true", ...CONTAINER_LABELS.slice(0, 2), "other-workspace", ...CONTAINER_LABELS.slice(3), "7"].join("|")],
    ["wrong-project", [CONTAINER_ID, "true", ...CONTAINER_LABELS.slice(0, 3), "other-project", ...CONTAINER_LABELS.slice(4), "7"].join("|")],
    ["wrong-repository", [CONTAINER_ID, "true", ...CONTAINER_LABELS.slice(0, 5), "other-repo", ...CONTAINER_LABELS.slice(6), "7"].join("|")],
    ["wrong-backend", [CONTAINER_ID, "true", ...CONTAINER_LABELS.slice(0, 6), "runc", ...CONTAINER_LABELS.slice(7), "7"].join("|")]
  ])("leaves a %s same-name container untouched", async (_kind, containerInspect) => {
    // Given
    const runner = new OwnershipRunner({ containerInspect });
    const state = new LifecycleState(root);

    // When / Then
    await expect(discardWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), workspace.name))
      .rejects.toThrow(/conflicts with DIM ownership/);
    expect(runner.streamingCalls).toHaveLength(0);
    expect(runner.runCalls.some((call) => call[1] === "container" && call[2] === "rm")).toBe(false);
    expect(runner.runCalls.some((call) => call[1] === "volume" && call[2] === "rm")).toBe(false);
    await expect(state.readWorkspace(workspace.name)).resolves.toEqual(workspace);
  });

  it.each([
    ["foreign", ["dim-ws-work-1-docker", "false", "work-1", "workspace-docker"].join("|")],
    ["partial", ["dim-ws-work-1-docker", "true", "work-1"].join("|")],
    ["mismatched", ["dim-ws-work-1-docker", ...VOLUME_LABELS.slice(0, 2), "other", ...VOLUME_LABELS.slice(3)].join("|")]
  ])("preflights a %s same-name volume before teardown and leaves every resource untouched", async (_kind, volumeInspect) => {
    // Given
    const runner = new OwnershipRunner({ volumeInspect });
    const state = new LifecycleState(root);

    // When / Then
    await expect(discardWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), workspace.name))
      .rejects.toThrow(/conflicts with DIM ownership/);
    expect(runner.streamingCalls).toHaveLength(0);
    expect(runner.runCalls.some((call) => call[1] === "container" && call[2] === "rm")).toBe(false);
    expect(runner.runCalls.some((call) => call[1] === "volume" && call[2] === "rm")).toBe(false);
    await expect(state.readWorkspace(workspace.name)).resolves.toEqual(workspace);
  });

  it("validates a retained volume before Project teardown", async () => {
    // Given
    const runner = new OwnershipRunner({
      volumeInspect: [workspace.dockerVolumeName, ...VOLUME_LABELS.slice(0, 2), "other", ...VOLUME_LABELS.slice(3)].join("|")
    });

    // When / Then
    await expect(discardWorkspace(
      runner,
      lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }),
      workspace.name,
      true
    )).rejects.toThrow(/conflicts with DIM ownership/);
    expect(runner.streamingCalls).toHaveLength(0);
    expect(runner.runCalls.some((call) => call[2] === "rm")).toBe(false);
  });

  it("runs teardown and removal against the inspected container ID", async () => {
    // Given
    const runner = new OwnershipRunner();

    // When
    await discardWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), workspace.name);

    // Then
    expect(runner.streamingCalls[0]).toContain(CONTAINER_ID);
    expect(runner.runCalls).toContainEqual(["docker", "container", "rm", "--force", CONTAINER_ID]);
    expect(runner.runCalls).not.toContainEqual(["docker", "container", "rm", "--force", workspace.containerName]);
  });

  it("completes cleanup when owned resources disappear after inspection", async () => {
    // Given
    const runner = new OwnershipRunner({
      containerRemoveError: `Error response from daemon: No such container: ${CONTAINER_ID}`,
      volumeRemoveError: `Error response from daemon: No such volume: ${workspace.dockerVolumeName}`
    });
    const state = new LifecycleState(root);

    // When
    await discardWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), workspace.name);

    // Then
    await expect(state.readWorkspace(workspace.name)).rejects.toThrow(/not found/);
  });

  it("reinspects a volume immediately before removal and leaves a foreign replacement untouched", async () => {
    // Given
    const owned = [workspace.dockerVolumeName, ...VOLUME_LABELS].join("|");
    const foreign = [workspace.dockerVolumeName, ...VOLUME_LABELS.slice(0, 1), "foreign", ...VOLUME_LABELS.slice(2)].join("|");
    const runner = new OwnershipRunner({ volumeInspects: [owned, foreign] });
    const state = new LifecycleState(root);

    // When / Then
    await expect(discardWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), workspace.name))
      .rejects.toThrow(/conflicts with DIM ownership/);
    const finalInspect = runner.runCalls.at(-1);
    expect(finalInspect?.slice(1, 3)).toEqual(["volume", "inspect"]);
    expect(runner.runCalls.some((call) => call[1] === "volume" && call[2] === "rm")).toBe(false);
    await expect(state.readWorkspace(workspace.name)).resolves.toEqual(workspace);
  });

  it("treats exactly absent resources as a safe discard retry", async () => {
    // Given
    const runner = new OwnershipRunner({
      containerInspectError: `Error response from daemon: No such container: ${workspace.containerName}`,
      volumeInspectError: `Error: No such volume: ${workspace.dockerVolumeName}`
    });
    const state = new LifecycleState(root);

    // When
    await discardWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), workspace.name);

    // Then
    expect(runner.streamingCalls).toHaveLength(0);
    expect(runner.runCalls.some((call) => call[2] === "rm")).toBe(false);
    await expect(state.readWorkspace(workspace.name)).rejects.toThrow(/not found/);
  });
});

function workspaceRecord(rootSnapshotPath: string): WorkspaceRecord {
  const timestamp = "2026-09-12T00:00:00.000Z";
  return {
    schemaVersion: 5,
    name: "work-1",
    projectId: "project-id",
    projectName: "project",
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    rootCommit: "b".repeat(40),
    rootSnapshotPath,
    repositoryRefOverrides: {},
    repositorySnapshot: {
      root: {
        workspaceUrl: "http://dim-gitea:3000/dim-project/root.git",
        phase: "ready",
        root: true,
        requestedRef: "refs/heads/main",
        ref: "refs/heads/main",
        commit: "b".repeat(40)
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
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function labelValue(label: string): string {
  return label.slice(label.indexOf("=") + 1);
}
