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
  createWorkspace,
  runWorkspace,
  setupWorkspace,
  updateWorkspace,
  updateWorkspaceResources
} from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { withWorkspaceLifecycleProgress } from "../../../../core/packages/core/src/workspaceLifecycleError.js";

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
    runner.containerRootSnapshotPath = join(root, "assets", "project-roots", workspace.projectId, workspace.rootCommit);
    await state.claimProject(project);
    await mkdir(runner.containerRootSnapshotPath, { recursive: true });
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
    runner.containerRootSnapshotPath = join(root, "assets", "project-roots", workspace.projectId, workspace.rootCommit);

    // When
    const updating = updateWorkspace(runner, options(root), workspace.name);

    // Then
    await expect(updating).rejects.toThrow(
      /workspace update at protected root publication: failed to write project runtime manifest: injected manifest failure/
    );
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

  it("identifies host-input helper installation when workspace reconciliation fails", async () => {
    // Given
    const run = runner.run.bind(runner);
    runner.run = async (command, args) => args.some((argument) => argument.startsWith("DIM_HOST_INPUT_HELPER_B64="))
      ? { command, args, stdout: "", stderr: "injected permission failure", exitCode: 1 }
      : run(command, args);

    // When
    const updating = updateWorkspace(runner, options(root), workspace.name);

    // Then
    await expect(updating).rejects.toThrow(
      "workspace update at workspace reconciliation: workspace reconciliation at host-input helper installation: failed to install host input helper: injected permission failure"
    );
    await expect(updating).rejects.not.toThrow(/writer-secret|admin-secret|maintainer-secret/);
    await expect(state.readWorkspace(workspace.name)).resolves.toMatchObject({
      phase: "error",
      error: "workspace reconciliation at host-input helper installation: failed to install host input helper: injected permission failure"
    });
  });

  it("identifies invalid update profiles as profile validation", async () => {
    // Given / When
    const updating = updateWorkspace(runner, options(root), workspace.name, ["bad,profile"]);

    // Then
    await expect(updating).rejects.toMatchObject({
      message: "workspace update at profile validation: workspace profile 'bad,profile' must match [a-z0-9][a-z0-9_.-]{0,63}",
      cause: expect.objectContaining({
        message: "workspace profile 'bad,profile' must match [a-z0-9][a-z0-9_.-]{0,63}"
      })
    });
    expect(runner.lifecycleEvents).toEqual([]);
  });

  it("identifies create-time Project manifest publication failures", async () => {
    // Given
    await state.removeWorkspace(workspace.name);
    runner = new UpdateRunner(1);
    runner.containerExists = false;
    runner.containerRootSnapshotPath = join(root, "assets", "project-roots", project.id, COMMIT);

    // When
    const creation = createWorkspace(runner, options(root), {
      project: project.name,
      name: workspace.name,
      profiles: workspace.profiles,
      runtimeBackend: "sysbox",
      kvm: false
    });

    // Then
    await expect(creation).rejects.toMatchObject({
      message: "workspace create at Project manifest publication: failed to write project runtime manifest: injected manifest failure",
      cause: expect.objectContaining({
        message: "failed to write project runtime manifest: injected manifest failure"
      })
    });
  });

  it("identifies reconciliation workspace-lock release failures after releasing the real lock", async () => {
    // Given
    const acquireWorkspaceLock = LifecycleState.prototype.acquireWorkspaceLock;
    let releaseAttempts = 0;
    vi.spyOn(LifecycleState.prototype, "acquireWorkspaceLock").mockImplementation(async function (
      this: LifecycleState,
      name: string
    ) {
      const release = await acquireWorkspaceLock.call(this, name);
      return async () => {
        releaseAttempts += 1;
        await release();
        throw new Error("injected reconciliation lock release failure");
      };
    });

    // When
    const updating = updateWorkspace(runner, options(root), workspace.name);

    // Then
    await expect(updating).rejects.toMatchObject({
      message: "workspace update at workspace reconciliation lock release: injected reconciliation lock release failure",
      cause: expect.objectContaining({ message: "injected reconciliation lock release failure" })
    });
    expect(releaseAttempts).toBe(1);
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
    await expect(updating).rejects.toThrow(
      "workspace update at ready-state publication: injected ready write failure"
    );
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
    runner.containerRootSnapshotPath = join(root, "assets", "project-roots", workspace.projectId, workspace.rootCommit);
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
    runner.containerRootSnapshotPath = join(root, "assets", "project-roots", workspace.projectId, workspace.rootCommit);
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
    await expect(updating).rejects.toMatchObject({
      message: "workspace update at Project setup: project setup exited with 17",
      cause: expect.objectContaining({ message: "project setup exited with 17" })
    });
    expect(runner.lifecycleEvents).toEqual([
      "container-remove", "container-create", "manifest-publication", "project-setup"
    ]);
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

  it("does not report Project setup re-entry while publishing its failure", async () => {
    // Given
    runner = new UpdateRunner(0, 17);
    runner.containerRootSnapshotPath = join(root, "assets", "project-roots", workspace.projectId, workspace.rootCommit);
    const stages: string[] = [];

    // When
    const updating = withWorkspaceLifecycleProgress(
      (_operation, stage) => stages.push(stage),
      () => updateWorkspace(runner, options(root), workspace.name)
    );

    // Then
    await expect(updating).rejects.toThrow("workspace update at Project setup: project setup exited with 17");
    const setupStart = stages.lastIndexOf("setup-state publication");
    expect(stages.slice(setupStart)).toEqual([
      "setup-state publication",
      "Project setup",
      "setup-error publication",
      "workspace setup lock release",
      "Project lock release"
    ]);
  });

  it("replaces the owned outer container before setup when the approved root changes", async () => {
    // Given
    const selectedRootPath = join(root, "assets", "project-roots", project.id, COMMIT);

    // When
    const updated = await updateWorkspace(runner, options(root), workspace.name);

    // Then
    expect(updated).toMatchObject({ phase: "ready", rootCommit: COMMIT });
    expect(updated).not.toHaveProperty("rootSnapshotPath");
    expect(runner.lifecycleEvents).toEqual(["container-remove", "container-create", "manifest-publication"]);
    expect(runner.containerRootSnapshotPath).toBe(selectedRootPath);
    expect(runner.runCalls.some((call) => call[1] === "volume" && call[2] === "rm")).toBe(false);
  });

  it("keeps the owned outer container when the approved root is unchanged", async () => {
    // Given
    const selectedRootPath = join(root, "assets", "project-roots", project.id, COMMIT);
    workspace = { ...workspace, rootCommit: COMMIT };
    await state.writeWorkspace(workspace);
    runner.containerRootSnapshotPath = selectedRootPath;

    // When
    await updateWorkspace(runner, options(root), workspace.name);

    // Then
    expect(runner.lifecycleEvents).toEqual(["manifest-publication"]);
    expect(runner.runCalls.some((call) => call[1] === "container" && call[2] === "rm")).toBe(false);
    expect(runner.runCalls.some((call) => call[1] === "run")).toBe(false);
  });
});
