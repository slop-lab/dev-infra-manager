import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/managed/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/managed/src/lifecycleState.js";
import * as nativeWorkspaceSelection from "../../../../core/packages/managed/src/nativeWorkspaceSelection.js";
import type {
  ProjectRecord,
  WorkspaceRecord
} from "../../../../core/packages/managed/src/lifecycleTypes.js";
import type {
  CommandResult,
  StreamingCommandRunner
} from "../../../../core/packages/core/src/types.js";
import {
  runWorkspace,
  setupWorkspace,
  updateWorkspace,
  updateWorkspaceResources
} from "../../../../core/packages/managed/src/workspaceLifecycle.js";

import {
  options, projectFixture, seedSelectedRootSnapshot, selectedWorkspaceFixture, workspaceFixture
} from "./workspaceUpdateLockFixture.js";
import { COMMIT, LockInterleaving, MOVED_HEAD_COMMIT, MOVED_SOURCE_COMMIT, UpdateRunner } from "./workspaceUpdateLockRunner.js";

describe("workspace update setup lock", () => {
  let root = "";
  let state = new LifecycleState("/uninitialized");
  let project: ProjectRecord;
  let workspace: WorkspaceRecord;
  let runner: UpdateRunner;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-workspace-update-lock-"));
    state = new LifecycleState(root);
    project = projectFixture();
    workspace = workspaceFixture(project);
    runner = new UpdateRunner();
    runner.containerRootSnapshotPath = join(root, "assets", "native-project-roots", workspace.projectId, workspace.rootCommit);
    await state.claimProject(project);
    await mkdir(runner.containerRootSnapshotPath, { recursive: true });
    await mkdir(join(root, "assets", "native-project-roots", project.projectId, COMMIT), { recursive: true });
    await seedSelectedRootSnapshot(root, project);
    await state.claimWorkspace(workspace);
    vi.spyOn(nativeWorkspaceSelection, "selectCurrentNativeWorkspaceRoot")
      .mockImplementation(async (_options, record) => selectedWorkspaceFixture(record));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });


it("preserves a resource update completed before the setup lock is acquired", async () => {
    // Given
    const locks = new LockInterleaving();
    locks.install();
    const updating = updateWorkspace(runner, options(root), workspace.name, ["review"]);
    await locks.firstSetupAttempted.wait;

    // When
    await updateWorkspaceResources(runner, options(root), workspace.name, {
      memory: "8g",
      pidsLimit: "4096"
    });
    locks.allowFirstSetup.open();
    await updating;

    // Then
    expect(locks.projectHeldAtFirstSetup).toBe(true);
    await expect(state.readWorkspace(workspace.name)).resolves.toMatchObject({
      profiles: ["review"],
      cpuCount: "2",
      memory: "8g",
      pidsLimit: "4096"
    });
  });

it("fails closed when the workspace disappears before the setup lock is acquired", async () => {
    // Given
    const locks = new LockInterleaving();
    locks.install();
    const updating = updateWorkspace(runner, options(root), workspace.name);
    await locks.firstSetupAttempted.wait;
    const release = await state.acquireWorkspaceSetupLock(workspace.name);
    await state.removeWorkspace(workspace.name);
    await release();

    // When
    locks.allowFirstSetup.open();

    // Then
    await expect(updating).rejects.toThrow(/workspace 'work-1' not found/);
    await expect(state.readWorkspace(workspace.name)).rejects.toThrow(/not found/);
  });

it("fails closed when the workspace Project identity changes before setup lock acquisition", async () => {
    // Given
    const locks = new LockInterleaving();
    locks.install();
    const updating = updateWorkspace(runner, options(root), workspace.name);
    await locks.firstSetupAttempted.wait;
    const replacement = { ...workspace, projectId: "replacement-id", projectName: "replacement" };
    const release = await state.acquireWorkspaceSetupLock(workspace.name);
    await state.writeWorkspace(replacement);
    await release();

    // When
    locks.allowFirstSetup.open();

    // Then
    await expect(updating).rejects.toThrow(/native source changed during update/);
    await expect(state.readWorkspace(workspace.name)).resolves.toEqual(replacement);
  });
});
