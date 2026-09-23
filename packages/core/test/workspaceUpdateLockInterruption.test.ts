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

import { options, projectFixture, workspaceFixture } from "./workspaceUpdateLockFixture.js";
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


it("replays the recorded root and manifest before direct setup recovery from setting-up", async () => {
    // Given
    const targetSnapshotPath = join(root, "assets", "project-roots", project.id, COMMIT);
    const interrupted = {
      ...workspace,
      phase: "setting-up",
      rootRef: "refs/heads/main",
      rootCommit: COMMIT,
      rootSnapshotPath: targetSnapshotPath
    } as const;
    await state.writeWorkspace(interrupted);
    runner = new UpdateRunner(0, 0);

    // When
    const recovered = await setupWorkspace(runner, options(root), workspace.name);

    // Then
    expect(recovered).toMatchObject({ phase: "ready", rootCommit: COMMIT, rootSnapshotPath: targetSnapshotPath });
    expect(runner.runCalls.some((call) => call.includes("ls-remote"))).toBe(false);
    expect(runner.runCalls.some((call) => call.includes("fetch"))).toBe(false);
    expect(runner.publishedManifests[0]).not.toHaveProperty("repositories");
    expect(runner.streamingCalls[0]).toContain("/run/dim/project-root/.dim/setup.sh");
    expect(runner.runCalls.some((call) => call.includes("git"))).toBe(false);
    expect(runner.lifecycleEvents).toEqual(["manifest-publication", "project-setup"]);
  });

it("recovers an interruption after snapshot persistence without resolving moved repositories", async () => {
    // Given
    const writeWorkspace = LifecycleState.prototype.writeWorkspace;
    let interrupted = false;
    vi.spyOn(LifecycleState.prototype, "writeWorkspace").mockImplementation(async function (
      this: LifecycleState,
      record: WorkspaceRecord
    ) {
      await writeWorkspace.call(this, record);
      if (!interrupted && record.phase === "setting-up" && record.rootCommit === COMMIT) {
        interrupted = true;
        throw new Error("injected interruption after snapshot persistence");
      }
    });
    await expect(updateWorkspace(runner, options(root), workspace.name)).rejects.toThrow(
      /injected interruption after snapshot persistence/
    );
    await expect(state.readWorkspace(workspace.name)).resolves.toMatchObject({
      phase: "setting-up",
      rootCommit: COMMIT
    });
    runner.sourceCommit = MOVED_SOURCE_COMMIT;
    runner.headCommit = MOVED_HEAD_COMMIT;
    runner.runCalls.length = 0;
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));

    // When
    await setupWorkspace(runner, options(root), workspace.name);

    // Then
    expect(runner.runCalls.some((call) => call.includes("ls-remote"))).toBe(false);
    expect(runner.runCalls.some((call) => call.includes("fetch"))).toBe(false);
    expect(runner.publishedManifests[0]).not.toHaveProperty("repositories");
  });

it("recovers a manifest failure through direct setup from the recorded root", async () => {
    // Given
    runner = new UpdateRunner(1, 0);
    await expect(updateWorkspace(runner, options(root), workspace.name)).rejects.toThrow(
      /failed to write project runtime manifest/
    );
    const originallyPublished = runner.publishedManifests[0]?.root;
    runner.sourceCommit = MOVED_SOURCE_COMMIT;
    runner.headCommit = MOVED_HEAD_COMMIT;
    runner.runCalls.length = 0;
    runner.streamingCalls.length = 0;
    runner.lifecycleEvents.length = 0;

    // When
    const recovered = await setupWorkspace(runner, options(root), workspace.name);

    // Then
    expect(recovered).toMatchObject({ phase: "ready", rootCommit: COMMIT });
    expect(runner.runCalls.some((call) => call.includes("ls-remote"))).toBe(false);
    expect(runner.runCalls.some((call) => call.includes("fetch"))).toBe(false);
    expect(runner.publishedManifests[1]?.root).toEqual(originallyPublished);
    expect(runner.streamingCalls[0]).toContain("/run/dim/project-root/.dim/setup.sh");
    expect(runner.manifestPublicationAttempts).toBe(2);
    expect(runner.lifecycleEvents).toEqual(["manifest-publication", "project-setup"]);
  });
});
