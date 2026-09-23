import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type {
  ProjectRecord,
  WorkspaceRecord
} from "../../../../core/packages/core/src/lifecycleTypes.js";
import type {
  CommandResult,
  StreamingCommandRunner
} from "../../../../core/packages/core/src/types.js";
import {
  runWorkspace,
  setupWorkspace,
  updateWorkspace,
  updateWorkspaceResources
} from "../../../../core/packages/core/src/workspaceLifecycle.js";

import { options, projectFixture, repositorySnapshot, workspaceFixture } from "./workspaceUpdateLockFixture.js";
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
    workspace = workspaceFixture(root, project);
    runner = new UpdateRunner();
    await state.claimProject(project);
    await mkdir(workspace.rootSnapshotPath, { recursive: true });
    await mkdir(join(root, "assets", "project-roots", project.id, COMMIT), { recursive: true });
    await state.claimWorkspace(workspace);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });


it("keeps a post-fast-forward manifest failure non-ready and blocks run", async () => {
    // Given
    runner = new UpdateRunner(1);

    // When
    const updating = updateWorkspace(runner, options(root), workspace.name);

    // Then
    await expect(updating).rejects.toThrow(/failed to write project runtime manifest: injected manifest failure/);
    await expect(state.readWorkspace(workspace.name)).resolves.toMatchObject({
      phase: "setup-error",
      rootCommit: COMMIT,
      error: "failed to write project runtime manifest: injected manifest failure"
    });
    await expect(runWorkspace(runner, options(root), {
      name: workspace.name,
      command: ["codex"],
      interactive: false
    })).rejects.toThrow(/not ready \(phase: setup-error\)/);
    expect(runner.streamingCalls).toHaveLength(0);
  });

it("persists setup-error when the final ready write fails after manifest publication", async () => {
    // Given
    const writeWorkspace = LifecycleState.prototype.writeWorkspace;
    let readyWriteFailed = false;
    vi.spyOn(LifecycleState.prototype, "writeWorkspace").mockImplementation(async function (
      this: LifecycleState,
      record: WorkspaceRecord
    ) {
      if (!readyWriteFailed
        && runner.manifestPublicationAttempts > 0
        && record.rootCommit === COMMIT
        && record.phase === "ready") {
        readyWriteFailed = true;
        throw new Error("injected ready write failure");
      }
      await writeWorkspace.call(this, record);
    });

    // When
    const updating = updateWorkspace(runner, options(root), workspace.name);

    // Then
    await expect(updating).rejects.toThrow("injected ready write failure");
    expect(runner.manifestPublicationAttempts).toBe(1);
    await expect(state.readWorkspace(workspace.name)).resolves.toMatchObject({
      phase: "setup-error",
      rootCommit: COMMIT,
      error: "injected ready write failure"
    });
    await expect(runWorkspace(runner, options(root), {
      name: workspace.name,
      command: ["codex"],
      interactive: false
    })).rejects.toThrow(/not ready \(phase: setup-error\)/);
    expect(runner.streamingCalls).toHaveLength(0);
  });

it("recovers a failed manifest publication through a later update", async () => {
    // Given
    runner = new UpdateRunner(1);
    await expect(updateWorkspace(runner, options(root), workspace.name)).rejects.toThrow(
      /failed to write project runtime manifest/
    );

    // When
    const recovered = await updateWorkspace(runner, options(root), workspace.name);

    // Then
    expect(recovered).toMatchObject({ phase: "ready", rootCommit: COMMIT });
    await expect(state.readWorkspace(workspace.name)).resolves.toMatchObject({
      phase: "ready",
      rootCommit: COMMIT
    });
    expect(runner.manifestPublicationAttempts).toBe(2);
  });

it("does not publish ready between selected-root publication and failed Project setup", async () => {
    // Given
    runner = new UpdateRunner(0, 17);
    const persistedPhases: WorkspaceRecord["phase"][] = [];
    const writeWorkspace = LifecycleState.prototype.writeWorkspace;
    vi.spyOn(LifecycleState.prototype, "writeWorkspace").mockImplementation(async function (
      this: LifecycleState,
      record: WorkspaceRecord
    ) {
      await writeWorkspace.call(this, record);
      if (record.rootCommit === COMMIT) persistedPhases.push(record.phase);
    });

    // When
    const updating = updateWorkspace(runner, options(root), workspace.name);

    // Then
    await expect(updating).rejects.toThrow(/project setup exited with 17/);
    expect(runner.lifecycleEvents).toEqual(["manifest-publication", "project-setup"]);
    await expect(state.readWorkspace(workspace.name)).resolves.toMatchObject({
      phase: "setup-error",
      rootCommit: COMMIT,
      error: "project setup exited with 17"
    });
    await expect(runWorkspace(runner, options(root), {
      name: workspace.name,
      command: ["codex"],
      interactive: false
    })).rejects.toThrow(/not ready \(phase: setup-error\)/);
    expect(runner.streamingCalls).toHaveLength(1);
    expect(persistedPhases).not.toContain("ready");
  });
});
