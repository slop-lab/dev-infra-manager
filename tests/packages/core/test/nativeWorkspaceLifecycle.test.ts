import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeNativeGitRootImporterClient } from "../../../../core/packages/core/src/nativeGitRootImporterClient.js";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { loadNativeControlPlaneConnection } from "../../../../core/packages/core/src/nativeControlPlaneConnection.js";
import { NativeProjectPendingStore } from "../../../../core/packages/core/src/nativeProjectPendingStore.js";
import type { NativeWorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { shutdownHost, startHost } from "../../../../core/packages/core/src/hostLifecycle.js";
import { setupWorkspace, startWorkspace, restartWorkspace, updateWorkspace } from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { workspaceRootSnapshotPath } from "../../../../core/packages/core/src/workspaceLifecycleTypes.js";
import { cleanupNativeProjectFixtures, nativeFixture, rewriteJson,
  type NativeFixture } from "../../cli/test/nativeProjectCommandsFixture.js";
import { workspaceContainerInspect, workspaceVolumeInspect } from "./workspaceOwnershipFixture.js";

vi.mock("../../../../core/packages/core/src/registryCache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/registryCache.js")>(),
  ensureRegistryCache: vi.fn(async () => {})
}));

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupNativeProjectFixtures();
});

describe("native workspace lifecycle", () => {
  it("starts from a fresh native readiness proof without Gitea", async () => {
    // Given
    const context = await lifecycleFixture("stopped", false);
    await context.fixture.rolloverNativeGit();
    const before = context.fixture.readinessRequests();

    // When
    const result = await startWorkspace(context.runner, context.options, context.workspace.name);

    // Then
    expect(context.fixture.readinessRequests()).toBe(before + 1);
    expect(result).toMatchObject({ schemaVersion: 9, phase: "ready", source: context.workspace.source });
    expect(context.runner.calls.some((call) => call.includes("dim-gitea"))).toBe(false);
  });

  it("updates profiles from a fresh native readiness proof without Gitea", async () => {
    // Given
    const context = await lifecycleFixture("ready", true);
    await context.fixture.rolloverNativeGit();
    const before = context.fixture.readinessRequests();

    // When
    const result = await updateWorkspace(context.runner, context.options, context.workspace.name, ["review"]);

    // Then
    expect(context.fixture.readinessRequests()).toBe(before + 1);
    expect(result).toMatchObject({ schemaVersion: 9, phase: "ready", profiles: ["review"],
      source: context.workspace.source });
    expect(context.runner.calls.some((call) => call.includes("dim-gitea"))).toBe(false);
  });

  it("restarts from a fresh native readiness proof without Gitea", async () => {
    // Given
    const context = await lifecycleFixture("ready", true);
    await context.fixture.rolloverNativeGit();
    const before = context.fixture.readinessRequests();

    // When
    const result = await restartWorkspace(context.runner, context.options, context.workspace.name);

    // Then
    expect(context.fixture.readinessRequests()).toBe(before + 1);
    expect(result).toMatchObject({ schemaVersion: 9, phase: "ready", source: context.workspace.source });
    expect(context.runner.events).toEqual(expect.arrayContaining(["stop", "start"]));
    expect(context.runner.calls.some((call) => call.includes("dim-gitea"))).toBe(false);
  });

  it("rejects an environment change before stopping a native workspace", async () => {
    const context = await lifecycleFixture("ready", true);
    const current = { ...context.workspace, environment: "custom" as const };
    await context.state.writeWorkspace(current);

    await expect(restartWorkspace(context.runner, context.options, current.name)).rejects.toThrow(/environment changed/);
    expect(context.runner.events).not.toContain("stop");
    await expect(context.state.readWorkspace(current.name)).resolves.toMatchObject({ phase: "ready", environment: "custom" });
  });

  it("rejects an environment change before inspecting or fencing a native update", async () => {
    const context = await lifecycleFixture("ready", true);
    const current = { ...context.workspace, environment: "custom" as const };
    await context.state.writeWorkspace(current);

    await expect(updateWorkspace(context.runner, context.options, current.name)).rejects.toThrow(/environment changed/);
    expect(context.runner.calls).toEqual([]);
    await expect(context.state.readWorkspace(current.name)).resolves.toMatchObject({ phase: "ready", environment: "custom" });
  });

  it("preserves native workspace state when fresh readiness is rejected", async () => {
    // Given
    const context = await lifecycleFixture("ready", true);
    const before = await context.state.readWorkspace(context.workspace.name);
    await rewriteJson(context.fixture.controlPath, (value) => ({ ...value, nativeGit: {
      ...(value.nativeGit as object), workspaceWriteIssuer: {
        ...((value.nativeGit as { workspaceWriteIssuer: object }).workspaceWriteIssuer),
        password: Buffer.alloc(32, 99).toString("base64url")
      }
    } }));

    // When
    const operation = updateWorkspace(context.runner, context.options, context.workspace.name, ["review"]);

    // Then
    await expect(operation).rejects.toThrow(/readiness/);
    await expect(context.state.readWorkspace(context.workspace.name)).resolves.toEqual(before);
    expect(context.runner.calls).toEqual([]);
  });

  it("demotes ready and publishes relay error when native setup reconciliation fails", async () => {
    const context = await lifecycleFixture("ready", true);
    const current = { ...context.workspace, environment: "recommended" as const };
    await context.state.writeWorkspace(current);
    const runner = new NativeLifecycleRunner(current, workspaceRootSnapshotPath(context.fixture.stateRoot, current), true, true);

    await expect(setupWorkspace(runner, context.options, current.name)).rejects.toThrow(/host input helper/);

    await expect(context.state.readWorkspace(current.name)).resolves.toMatchObject({ phase: "error" });
    expect(runner.calls.filter((call) => call.at(-2) === "phase").map((call) => call.at(-1)))
      .toEqual(["setting-up", "error"]);
  });

  it("shuts down and restores only schema-9 workspaces from a fresh readiness proof", async () => {
    // Given
    const context = await lifecycleFixture("ready", true);
    await context.fixture.rolloverNativeGit();
    const before = context.fixture.readinessRequests();

    // When
    const stopped = await shutdownHost(context.runner, context.options);
    const restored = await startHost(context.runner, context.options);

    // Then
    expect(stopped).toMatchObject({ phase: "stopped", resumeWorkspaces: ["work-1"],
      restartCiRunners: [], resumeManagedContainers: [] });
    expect(restored).toMatchObject({ phase: "ready", resumeWorkspaces: [] });
    expect(context.fixture.readinessRequests()).toBe(before + 1);
    expect(context.runner.events).toEqual(["stop", "start"]);
    expect(context.runner.calls.some((call) => call.includes("dim-gitea"))).toBe(false);
    expect(context.runner.calls.some((call) => call[1] === "container" && call[2] === "ls")).toBe(false);
  });

  it("rejects provider workspace state before native host shutdown mutates resources", async () => {
    // Given
    const context = await lifecycleFixture("ready", true);
    await context.state.writeWorkspace({ ...context.workspace, schemaVersion: 8,
      gitBaseUrl: "http://dim-gitea:3000/acme" } as never);
    const callsBefore = context.runner.calls.length;

    // When
    const shutdown = shutdownHost(context.runner, context.options);

    // Then
    await expect(shutdown).rejects.toThrow(/expected 9/);
    expect(context.runner.calls).toHaveLength(callsBefore);
  });

  it("replays interrupted native setup from a fresh proof under host recovery", async () => {
    // Given
    const context = await lifecycleFixture("setup-error", false);
    await context.fixture.rolloverNativeGit();
    await context.state.writeHostLifecycle({
      schemaVersion: 2,
      phase: "stopped",
      resumeWorkspaces: [context.workspace.name],
      restartCiRunners: [],
      resumeManagedContainers: [],
      updatedAt: new Date(0).toISOString()
    });
    const before = context.fixture.readinessRequests();

    // When
    const result = await startHost(context.runner, context.options);

    // Then
    expect(result).toMatchObject({ phase: "ready", resumeWorkspaces: [] });
    expect(context.fixture.readinessRequests()).toBe(before + 1);
    await expect(context.state.readWorkspace(context.workspace.name)).resolves.toMatchObject({
      schemaVersion: 9,
      phase: "ready"
    });
    expect(context.runner.calls.some((call) => call.includes("dim-gitea"))).toBe(false);
  });
});

type LifecycleFixture = {
  readonly fixture: NativeFixture;
  readonly state: LifecycleState;
  readonly workspace: NativeWorkspaceRecord;
  readonly runner: NativeLifecycleRunner;
  readonly options: ReturnType<typeof lifecycleOptionsForBackend>;
};

async function lifecycleFixture(
  phase: NativeWorkspaceRecord["phase"],
  running: boolean
): Promise<LifecycleFixture> {
  const fixture = await nativeFixture();
  const projects = new NativeProjectPendingStore(fixture.stateRoot);
  await projects.admit("acme", await createNodeNativeGitRootImporterClient(fixture.importerPath),
    AbortSignal.timeout(10_000));
  const project = await projects.ready("acme",
    await loadNativeControlPlaneConnection(fixture.controlPath),
    AbortSignal.timeout(10_000));
  const now = new Date().toISOString();
  const workspace: NativeWorkspaceRecord = {
    schemaVersion: 9, workspaceId: Buffer.alloc(32, 31).toString("base64url"), name: "work-1",
    projectId: project.projectId, projectName: project.name, rootRepositoryAlias: project.rootAlias,
    rootRef: project.protectedRef, rootCommit: project.rootCommit,
    workspaceDataPath: "/var/lib/dim/workspace-data", phase, profiles: [],
    composeProjectName: "dim-work-1", containerName: "dim-ws-work-1", networkName: "bridge",
    dockerVolumeName: "dim-ws-work-1-docker", runtimeBackend: "sysbox", kvm: false,
    cpuCount: "2", memory: "4g", pidsLimit: "2048", routes: [], gitUserName: "DIM Test",
    gitUserEmail: "dim@example.invalid", hostAliases: {}, projectManifestPath: "/run/dim/project.json",
    createdAt: now, updatedAt: now,
    source: { kind: "native", serviceId: "native-main",
      snapshot: { projectId: project.projectId, repositoryId: "root",
        protectedRef: project.protectedRef, commit: project.rootCommit, tree: project.rootTree },
      policyRevision: project.reviewPolicy.policyRevision,
      requiredReviewRevision: project.reviewPolicy.requiredReviewRevision,
      requiredJobSetRevision: project.reviewPolicy.requiredJobSetRevision }
  };
  const state = new LifecycleState(fixture.stateRoot);
  await state.claimWorkspace(workspace);
  const runner = new NativeLifecycleRunner(workspace,
    workspaceRootSnapshotPath(fixture.stateRoot, workspace), running);
  return { fixture, state, workspace, runner,
    options: lifecycleOptionsForBackend("sysbox", fixture.environment) };
}

class NativeLifecycleRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];
  readonly events: string[] = [];
  private exists = true;

  constructor(
    private readonly workspace: NativeWorkspaceRecord,
    private mountedRoot: string,
    private running: boolean,
    private readonly failHostInput = false
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (args[0] === "volume" && args[1] === "inspect") {
      return result(command, args, `${workspaceVolumeInspect(this.workspace)}\n`);
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === this.workspace.containerName) {
      if (!this.exists) return result(command, args, "", 1, "Error: No such object");
      return result(command, args, `${workspaceContainerInspect(this.workspace,
        { running: this.running, rootSnapshotPath: this.mountedRoot })}\n`);
    }
    if (args[0] === "container" && args[1] === "rm") {
      this.exists = false;
      return result(command, args);
    }
    if (args[0] === "run") {
      this.exists = true;
      this.running = true;
      this.mountedRoot = args.find((argument) => argument.includes("target=/run/dim/project-root"))
        ?.match(/source=([^,]+)/)?.[1] ?? this.mountedRoot;
      return result(command, args);
    }
    if (args[0] === "start") {
      this.running = true;
      this.events.push("start");
      return result(command, args);
    }
    if (args[0] === "stop") {
      this.running = false;
      this.events.push("stop");
      return result(command, args);
    }
    if (args.includes("cgroup.subtree_control")) {
      return result(command, args, "systemd\ncgroup2fs\nyes\ncpu pids\n");
    }
    if (this.failHostInput && args.some((argument) => argument.startsWith("DIM_HOST_INPUT_HELPER_B64="))) {
      return result(command, args, "", 1, "injected helper failure");
    }
    if (args.at(-2) === "-f") return result(command, args, "", 1);
    return result(command, args);
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}

function result(command: string, args: string[], stdout = "", exitCode = 0, stderr = ""): CommandResult {
  return { command, args, stdout, stderr, exitCode };
}
