import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { setupWorkspace } from "../../../../core/packages/core/src/workspaceLifecycle.js";

import { claimTestGiteaService } from "./giteaServiceFixture.js";
import { COMMIT, LifecycleRunner, projectFixture } from "./workspaceLifecycleSnapshotFixture.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";

describe("immutable workspace lifecycle dispatch", () => {
  let root = "";
  let state: LifecycleState;
  let record: WorkspaceRecord;
  let project: ProjectRecord;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-lifecycle-snapshot-"));
    state = new LifecycleState(root);
    project = projectFixture();
    record = {
      schemaVersion: 8,
      workspaceId: "A".repeat(43),
      name: "work-1",
      projectId: "project-id",
      projectName: "project",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      rootCommit: COMMIT,
      workspaceDataPath: "/var/lib/dim/workspace-data",
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
      hostAliases: {},
      projectManifestPath: "/run/dim/project.json",
      createdAt: "now",
      updatedAt: "now"
    };
    await mkdir(join(root, "assets", "project-roots", record.projectId, record.rootCommit), { recursive: true });
    await state.claimProject(project);
    await claimTestGiteaService(root, 3300);
    await state.claimWorkspace(record);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

it("publishes a setup-error manifest solely from the recorded root contract", async () => {
    const runner = new LifecycleRunner();
    runner.containerInspect = workspaceContainerInspect(record, {
      rootSnapshotPath: join(root, "assets", "project-roots", record.projectId, record.rootCommit)
    });
    const failed = { ...record, phase: "setup-error" } as const;
    await state.writeWorkspace(failed);

    await setupWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), record.name);

    expect(runner.runCalls.some((call) => call.includes("ls-remote"))).toBe(false);
    expect(runner.publishedManifests[0]).toMatchObject({
      schemaVersion: 3,
      root: { ref: record.rootRef, commit: record.rootCommit, path: "/run/dim/project-root" },
      data: { path: record.workspaceDataPath }
    });
    expect(runner.publishedManifests[0]).not.toHaveProperty("repositories");
  });

  it("recovers a failed initial manifest publication without Git mutation", async () => {
    const runner = new LifecycleRunner();
    runner.containerInspect = workspaceContainerInspect(record, {
      rootSnapshotPath: join(root, "assets", "project-roots", record.projectId, record.rootCommit)
    });
    const failed = { ...record, phase: "error" } as const;
    await state.writeWorkspace(failed);

    await setupWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), record.name);

    expect(runner.runCalls.some((call) => call.includes("ls-remote"))).toBe(false);
    expect(runner.publishedManifests[0]).not.toHaveProperty("repositories");
  });

  it("rejects a same-name foreign replacement before recovery changes selected-root or Git state", async () => {
    const interrupted = { ...record, phase: "setup-error" as const };
    await state.writeWorkspace(interrupted);
    const runner = new LifecycleRunner();
    runner.containerInspect = workspaceContainerInspect(record, {
      rootSnapshotPath: join(root, "assets", "project-roots", record.projectId, record.rootCommit)
    })
      .replace("|project-id|", "|foreign-project-id|");

    await expect(setupWorkspace(
      runner,
      lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }),
      record.name
    )).rejects.toThrow(/conflicts with DIM ownership/);
    await expect(state.readWorkspace(record.name)).resolves.toMatchObject({
      phase: "error",
      rootCommit: interrupted.rootCommit,
      error: "workspace reconciliation at container inspection: Docker container 'dim-ws-work-1' conflicts with DIM ownership"
    });
    expect(runner.runCalls.some((call) => call.includes("git"))).toBe(false);
  });

  it("reconciles recovery when the owned container mounts a different immutable root", async () => {
    // Given
    const interrupted = { ...record, phase: "setup-error" as const };
    await state.writeWorkspace(interrupted);
    const runner = new LifecycleRunner();
    runner.containerInspect = workspaceContainerInspect(record, { rootSnapshotPath: join(root, "old-root") });

    // When
    const recovered = await setupWorkspace(
      runner,
      lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }),
      record.name
    );

    // Then
    expect(recovered).toMatchObject({ phase: "ready", rootCommit: record.rootCommit });
    expect(recovered).not.toHaveProperty("rootSnapshotPath");
    expect(runner.runCalls).toContainEqual(["docker", "container", "rm", "--force", "workspace-container-id"]);
    expect(runner.publishedManifests).toHaveLength(1);
    expect(runner.streamingCalls).toHaveLength(1);
  });

  it("recovers an omitted root ref from its recorded symbolic HEAD resolution after refs move", async () => {
    const runner = new LifecycleRunner();
    runner.containerInspect = workspaceContainerInspect(record, {
      rootSnapshotPath: join(root, "assets", "project-roots", record.projectId, record.rootCommit)
    });
    const headProject = { ...project };
    delete headProject.rootRef;
    await state.writeProject(headProject);
    await state.writeWorkspace({ ...record, phase: "setup-error" });

    await setupWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), record.name);

    expect(runner.runCalls.some((call) => call.includes("ls-remote"))).toBe(false);
    expect(runner.publishedManifests[0]?.root).toMatchObject({ ref: record.rootRef, commit: record.rootCommit });
  });
});
