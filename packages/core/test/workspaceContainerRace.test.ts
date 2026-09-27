import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileContainer } from "../../../../core/packages/core/src/workspaceContainer.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import {
  workspaceContainerLabels,
  workspaceVolumeLabels
} from "../../../../core/packages/core/src/workspaceResourceOwnership.js";
import { options, projectFixture, workspaceFixture } from "./workspaceUpdateLockFixture.js";

vi.mock("../../../../core/packages/core/src/registryCache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/registryCache.js")>(),
  ensureRegistryCache: vi.fn(async () => {})
}));

type Container = {
  readonly id: string;
  readonly name: string;
  readonly labels: readonly string[];
  readonly runtimeConfig: string;
  readonly rootSnapshotPath: string;
  running: boolean;
};

class WorkspaceDockerRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];
  private readonly containers = new Map<string, Container>();
  private readonly names = new Map<string, string>();
  private volumeLabels: readonly string[] | undefined;
  private containerCreateWinner: Container | undefined;
  private volumeCreateWinner: readonly string[] | undefined;
  private replacement: Container | undefined;

  constructor(private readonly record: WorkspaceRecord) {}

  addContainer(container: Container): void {
    this.containers.set(container.id, container);
    this.names.set(container.name, container.id);
  }

  addOwnedVolume(): void {
    this.volumeLabels = workspaceVolumeLabels(this.record);
  }

  replaceAfterNextContainerInspect(container: Container): void {
    this.replacement = container;
  }

  winContainerCreationWith(container: Container): void {
    this.containerCreateWinner = container;
  }

  winVolumeCreationWith(labels: readonly string[]): void {
    this.volumeCreateWinner = labels;
  }

  current(name: string): Container | undefined {
    const id = this.names.get(name);
    return id === undefined ? undefined : this.containers.get(id);
  }

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (args[0] === "volume" && args[1] === "inspect") return this.inspectVolume(command, args);
    if (args[0] === "volume" && args[1] === "create") {
      this.volumeLabels = this.volumeCreateWinner ?? workspaceVolumeLabels(this.record);
      return result(command, args, 0, this.record.dockerVolumeName);
    }
    if (args[0] === "container" && args[1] === "inspect") return this.inspectContainer(command, args);
    if (args[0] === "run") {
      if (this.containerCreateWinner !== undefined) {
        this.addContainer(this.containerCreateWinner);
      } else {
        const rootMount = args.find((argument) => argument.includes("target=/run/dim/project-root"));
        const rootSnapshotPath = rootMount?.match(/source=([^,]+)/)?.[1] ?? "missing";
        this.addContainer(container(this.record, { id: "created-id", running: true, rootSnapshotPath }));
      }
      return result(command, args, this.containerCreateWinner === undefined ? 0 : 1, "", "name already in use");
    }
    if (args[0] === "container" && args[1] === "rm") return this.removeContainer(command, args);
    if (args[0] === "start") return this.setRunning(command, args);
    if (args[0] === "exec") return result(command, args);
    return result(command, args, 1, "", "unexpected command");
  }

  async runStreaming(): Promise<number> {
    return 0;
  }

  private inspectVolume(command: string, args: string[]): CommandResult {
    if (this.volumeLabels === undefined) {
      return result(command, args, 1, "", `Error: No such volume: ${this.record.dockerVolumeName}`);
    }
    return result(command, args, 0, [this.record.dockerVolumeName, ...this.volumeLabels.map(labelValue)].join("|"));
  }

  private inspectContainer(command: string, args: string[]): CommandResult {
    const target = args[2] ?? "";
    const container = this.resolve(target);
    if (container === undefined) return result(command, args, 1, "", `Error: No such object: ${target}`);
    const output = [
      container.id,
      String(container.running),
      ...container.labels.map(labelValue),
      container.runtimeConfig,
      JSON.stringify([{
        Type: "bind",
        Source: container.rootSnapshotPath,
        Destination: "/run/dim/project-root",
        RW: false
      }])
    ].join("|");
    if (this.replacement !== undefined) {
      this.addContainer(this.replacement);
      this.replacement = undefined;
    }
    return result(command, args, 0, output);
  }

  private removeContainer(command: string, args: string[]): CommandResult {
    const target = args.at(-1) ?? "";
    const container = this.resolve(target);
    if (container === undefined) return result(command, args, 1, "", `Error: No such container: ${target}`);
    this.containers.delete(container.id);
    if (this.names.get(container.name) === container.id) this.names.delete(container.name);
    return result(command, args);
  }

  private setRunning(command: string, args: string[]): CommandResult {
    const target = args[1] ?? "";
    const container = this.resolve(target);
    if (container === undefined) return result(command, args, 1, "", `Error: No such container: ${target}`);
    container.running = true;
    return result(command, args);
  }

  private resolve(target: string): Container | undefined {
    const id = this.containers.has(target) ? target : this.names.get(target);
    return id === undefined ? undefined : this.containers.get(id);
  }
}

let root = "";

describe("workspace container reconciliation ownership races", () => {
  let record: WorkspaceRecord;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-workspace-container-race-"));
    record = workspaceFixture(root, projectFixture());
    await mkdir(join(root, "assets", "project-roots", record.projectId, record.rootCommit), { recursive: true });
    await new LifecycleState(root).claimWorkspace(record);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("rejects a foreign volume that wins the inspect-create race", async () => {
    // Given
    const runner = new WorkspaceDockerRunner(record);
    runner.winVolumeCreationWith(foreignLabels(workspaceVolumeLabels(record)));

    // When / Then
    await expect(reconcile(runner, record, root)).rejects.toThrow(/conflicts with DIM ownership/);
    expect(runner.calls.some((call) => call[1] === "container" && call[2] === "inspect")).toBe(false);
  });

  it("rejects a foreign container that wins the inspect-create race", async () => {
    // Given
    const runner = new WorkspaceDockerRunner(record);
    runner.addOwnedVolume();
    runner.winContainerCreationWith(container(record, { id: "foreign-id", running: false, foreign: true }));

    // When / Then
    await expect(reconcile(runner, record, root)).rejects.toThrow(/conflicts with DIM ownership/);
    expect(runner.current(record.containerName)).toMatchObject({ id: "foreign-id", running: false });
    expect(runner.calls.some((call) => call[1] === "container" && call[2] === "rm")).toBe(false);
  });

  it("starts inspected ID A without starting foreign replacement B", async () => {
    // Given
    const runner = new WorkspaceDockerRunner(record);
    runner.addOwnedVolume();
    runner.addContainer(container(record, { id: "owned-id", running: false }));
    runner.replaceAfterNextContainerInspect(container(record, { id: "foreign-id", running: false, foreign: true }));

    // When
    await reconcile(runner, record, root);

    // Then
    expect(runner.calls).toContainEqual(["docker", "start", "owned-id"]);
    expect(runner.calls).not.toContainEqual(["docker", "start", record.containerName]);
    expect(runner.current(record.containerName)).toMatchObject({ id: "foreign-id", running: false });
  });

  it("removes stale inspected ID A without removing foreign replacement B", async () => {
    // Given
    const runner = new WorkspaceDockerRunner(record);
    runner.addOwnedVolume();
    runner.addContainer(container(record, { id: "stale-id", running: true, runtimeConfig: "6" }));
    runner.replaceAfterNextContainerInspect(container(record, { id: "foreign-id", running: true, foreign: true }));
    runner.winContainerCreationWith(container(record, { id: "foreign-id", running: true, foreign: true }));

    // When / Then
    await expect(reconcile(runner, record, root)).rejects.toThrow(/conflicts with DIM ownership/);
    expect(runner.calls).toContainEqual(["docker", "container", "rm", "--force", "stale-id"]);
    expect(runner.calls).not.toContainEqual(["docker", "container", "rm", "--force", record.containerName]);
    expect(runner.current(record.containerName)).toMatchObject({ id: "foreign-id" });
  });

  it("replaces an owned container whose immutable root mount differs from the record", async () => {
    // Given
    const runner = new WorkspaceDockerRunner(record);
    runner.addOwnedVolume();
    runner.addContainer(container(record, {
      id: "old-root-id",
      running: true,
      rootSnapshotPath: join(root, "old-root")
    }));

    // When
    const containerId = await reconcile(runner, record, root);

    // Then
    expect(containerId).toBe("created-id");
    expect(runner.calls).toContainEqual(["docker", "container", "rm", "--force", "old-root-id"]);
    expect(runner.current(record.containerName)).toMatchObject({
      id: "created-id",
      rootSnapshotPath: join(root, "assets", "project-roots", record.projectId, record.rootCommit)
    });
  });

  it("keeps an owned container when its immutable root mount already matches", async () => {
    // Given
    const runner = new WorkspaceDockerRunner(record);
    runner.addOwnedVolume();
    runner.addContainer(container(record, { id: "matching-root-id", running: true }));

    // When
    const containerId = await reconcile(runner, record, root);

    // Then
    expect(containerId).toBe("matching-root-id");
    expect(runner.calls.some((call) => call[1] === "container" && call[2] === "rm")).toBe(false);
  });
});

function container(
  record: WorkspaceRecord,
  input: {
    readonly id: string;
    readonly running: boolean;
    readonly runtimeConfig?: string;
    readonly rootSnapshotPath?: string;
    readonly foreign?: boolean;
  }
): Container {
  const labels = workspaceContainerLabels(record);
  return {
    id: input.id,
    name: record.containerName,
    labels: input.foreign ? foreignLabels(labels) : labels,
    running: input.running,
    runtimeConfig: input.runtimeConfig ?? "8",
    rootSnapshotPath: input.rootSnapshotPath ?? join(root, "assets", "project-roots", record.projectId, record.rootCommit)
  };
}

function foreignLabels(labels: readonly string[]): readonly string[] {
  return labels.map((label) => label.startsWith("dim.owner=") ? "dim.owner=foreign" : label);
}

function labelValue(label: string): string {
  return label.slice(label.indexOf("=") + 1);
}

function reconcile(runner: StreamingCommandRunner, record: WorkspaceRecord, stateRoot: string): Promise<string> {
  return reconcileContainer(runner, options(stateRoot), record, {
    username: "writer", token: "token", userName: "Agent", userEmail: "agent@example.invalid"
  });
}

function result(command: string, args: string[], exitCode = 0, stdout = "", stderr = ""): CommandResult {
  return { command, args, exitCode, stdout, stderr };
}
