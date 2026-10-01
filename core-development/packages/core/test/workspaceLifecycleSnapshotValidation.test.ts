import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { COMMIT, projectFixture } from "./workspaceLifecycleSnapshotFixture.js";

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
    await state.claimWorkspace(record);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

it("rejects obsolete repository catalogs in schema 8 state", async () => {
  // Given
  await writeFile(state.workspacePath(record.name), JSON.stringify({
    ...record,
    repositorySnapshot: { root: { commit: COMMIT } }
  }));

  // When / Then
  await expect(state.readWorkspace(record.name)).rejects.toThrow(/obsolete repository catalog/);
});

  it("rejects a schema 8 record with a noncanonical data path", async () => {
  // Given
  await writeFile(state.workspacePath(record.name), JSON.stringify({
    ...record,
    workspaceDataPath: "/workspace"
  }));

  // When / Then
    await expect(state.readWorkspace(record.name)).rejects.toThrow(/workspace data path/);
  });

  it("accepts schema 8 state without a persisted protected-root path", async () => {
    // Given
    await writeFile(state.workspacePath(record.name), JSON.stringify({
      ...record
    }));

    // When / Then
    await expect(state.readWorkspace(record.name)).resolves.not.toHaveProperty("rootSnapshotPath");
  });

  it("rejects schema 8 state that persists a protected-root path", async () => {
    // Given
    await writeFile(state.workspacePath(record.name), JSON.stringify({
      ...record,
      rootSnapshotPath: join(root, "other-root")
    }));

    // When / Then
    await expect(state.readWorkspace(record.name)).rejects.toThrow(/obsolete protected-root path/);
  });
});
