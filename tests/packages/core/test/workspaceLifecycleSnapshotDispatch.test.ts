import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { runWorkspace, setupWorkspace } from "../../../../core/packages/core/src/workspaceLifecycle.js";

import { claimTestGiteaService } from "./giteaServiceFixture.js";
import { COMMIT, LifecycleRunner, MOVED_SOURCE_COMMIT, projectFixture, repositorySnapshot } from "./workspaceLifecycleSnapshotFixture.js";
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

it("dispatches entrypoint bytes from the recorded snapshot and exposes mutable Project data separately", async () => {
    // Given
    const runner = new LifecycleRunner();
    runner.containerInspect = workspaceContainerInspect(record, {
      rootSnapshotPath: join(root, "assets", "project-roots", record.projectId, record.rootCommit)
    });

    // When
    await runWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), {
      name: record.name,
      command: ["codex"],
      interactive: false
    });

    // Then
    const call = runner.streamingCalls[0] ?? [];
    expect(call).toContain("/run/dim/project-root/.dim/entrypoint.sh");
    expect(call).toContain("DIM_PROJECT_ROOT=/run/dim/project-root");
    expect(call).toContain("DIM_WORKSPACE_DATA=/var/lib/dim/workspace-data");
    expect(call.join(" ")).not.toContain("/workspace/project/.dim/entrypoint.sh");
  });

it("retries setup from the recorded commit without resolving a mutable branch", async () => {
    // Given
    const runner = new LifecycleRunner();
    runner.containerInspect = workspaceContainerInspect(record, {
      rootSnapshotPath: join(root, "assets", "project-roots", record.projectId, record.rootCommit)
    });

    // When
    await setupWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), record.name);

    // Then
    expect(runner.streamingCalls[0]).toContain("/run/dim/project-root/.dim/setup.sh");
    expect(runner.runCalls.some((call) => call.includes("ls-remote"))).toBe(false);
  });

it("runs Compose fallback and its relative build context from immutable snapshot bytes", async () => {
    // Given
    const runner = new LifecycleRunner(new Set([".dim/docker-compose.yml"]));
    runner.containerInspect = workspaceContainerInspect(record, {
      rootSnapshotPath: join(root, "assets", "project-roots", record.projectId, record.rootCommit)
    });

    // When
    await setupWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), record.name);

    // Then
    const call = runner.streamingCalls[0] ?? [];
    expect(call).toContain("/run/dim/project-root/.dim/docker-compose.yml");
    expect(call).toContain("/run/dim/project-root");
    expect(call.join(" ")).not.toContain("/workspace/project/.dim/docker-compose.yml");
  });

it("fails closed before trusted dispatch when the recorded snapshot is missing", async () => {
    // Given
    const runner = new LifecycleRunner();
    const rootSnapshotPath = join(root, "assets", "project-roots", record.projectId, record.rootCommit);
    runner.containerInspect = workspaceContainerInspect(record, { rootSnapshotPath });
    await rm(rootSnapshotPath, { recursive: true, force: true });

    // When / Then
    await expect(runWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), {
      name: record.name,
      command: ["codex"],
      interactive: false
    })).rejects.toThrow(/protected root snapshot.*is missing/);
    expect(runner.streamingCalls).toHaveLength(0);
  });
});
