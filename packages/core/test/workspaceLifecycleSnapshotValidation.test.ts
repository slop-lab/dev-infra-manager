import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { runWorkspace, setupWorkspace } from "../../../../core/packages/core/src/workspaceLifecycle.js";

import { COMMIT, LifecycleRunner, MOVED_SOURCE_COMMIT, projectFixture, repositorySnapshot } from "./workspaceLifecycleSnapshotFixture.js";

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
      schemaVersion: 5,
      name: "work-1",
      projectId: "project-id",
      projectName: "project",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      rootCommit: COMMIT,
      rootSnapshotPath: join(root, "assets", "project-roots", "project-id", COMMIT),
      repositorySnapshot: repositorySnapshot(),
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
      hostAliases: {},
      projectManifestPath: "/run/dim/project.json",
      createdAt: "now",
      updatedAt: "now"
    };
    await mkdir(record.rootSnapshotPath, { recursive: true });
    await state.claimProject(project);
    await state.claimWorkspace(record);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

it.each([
  ["requestedRef", {
    workspaceUrl: "http://workspace/source.git", phase: "ready", root: false,
    ref: "refs/heads/development", commit: COMMIT
  }],
  ["ref", {
    workspaceUrl: "http://workspace/source.git", phase: "ready", root: false,
    requestedRef: "refs/heads/development", commit: COMMIT
  }],
  ["commit", {
    workspaceUrl: "http://workspace/source.git", phase: "ready", root: false,
    requestedRef: "refs/heads/development", ref: "refs/heads/development"
  }]
] as const)("rejects a persisted ready snapshot entry missing %s", async (_field, source) => {
  // Given
  await writeFile(state.workspacePath(record.name), JSON.stringify({
    ...record,
    repositorySnapshot: { ...record.repositorySnapshot, source }
  }));

  // When / Then
  await expect(state.readWorkspace(record.name)).rejects.toThrow(/invalid repository snapshot/);
});

it.each(["creating", "importing", "error"] as const)(
  "rejects a persisted %s repository snapshot entry",
  async (phase) => {
    // Given
    await writeFile(state.workspacePath(record.name), JSON.stringify({
      ...record,
      repositorySnapshot: {
        ...record.repositorySnapshot,
        source: {
          workspaceUrl: "http://workspace/source.git",
          phase,
          root: false
        }
      }
    }));

    // When / Then
    await expect(state.readWorkspace(record.name)).rejects.toThrow(/invalid repository snapshot/);
  }
);

it("rejects a repository snapshot inconsistent with the recorded root", async () => {
    // Given
    await writeFile(state.workspacePath(record.name), JSON.stringify({
      ...record,
      repositorySnapshot: {
        ...record.repositorySnapshot,
        root: { ...record.repositorySnapshot["root"], commit: MOVED_SOURCE_COMMIT }
      }
    }));

    // When / Then
    await expect(state.readWorkspace(record.name)).rejects.toThrow(/invalid repository snapshot/);
  });

it("fails closed when the recorded repository snapshot omits a Project alias", async () => {
    // Given
    const incomplete = {
      ...record,
      phase: "setup-error",
      repositorySnapshot: { root: repositorySnapshot().root }
    } as const;
    await state.writeWorkspace(incomplete);

    // When / Then
    await expect(setupWorkspace(
      new LifecycleRunner(),
      lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }),
      record.name
    )).rejects.toThrow(/repository snapshot does not match project/);
  });
});
