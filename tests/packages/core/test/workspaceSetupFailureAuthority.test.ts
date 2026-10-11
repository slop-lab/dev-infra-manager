import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { updateWorkspace } from "../../../../core/packages/core/src/workspaceLifecycle.js";

import { claimTestGiteaService } from "./giteaServiceFixture.js";
import { options, projectFixture, workspaceFixture } from "./workspaceUpdateLockFixture.js";
import { COMMIT, UpdateRunner } from "./workspaceUpdateLockRunner.js";

describe("workspace setup failure authority", () => {
  let root = "";
  let state = new LifecycleState("/uninitialized");
  let project: ProjectRecord;
  let workspace: WorkspaceRecord;
  let runner: UpdateRunner;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-workspace-setup-failure-"));
    state = new LifecycleState(root);
    project = projectFixture();
    workspace = workspaceFixture(root, project);
    runner = new UpdateRunner();
    runner.containerRootSnapshotPath = join(root, "assets", "project-roots", workspace.projectId, workspace.rootCommit);
    await state.claimProject(project);
    await claimTestGiteaService(root, 3300);
    await mkdir(runner.containerRootSnapshotPath, { recursive: true });
    await mkdir(join(root, "assets", "project-roots", project.id, COMMIT), { recursive: true });
    await state.claimWorkspace(workspace);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the ready-state failure authoritative when setup-error publication also fails", async () => {
    // Given
    const writeWorkspace = LifecycleState.prototype.writeWorkspace;
    let readyWriteFailed = false;
    vi.spyOn(LifecycleState.prototype, "writeWorkspace").mockImplementation(async function (
      this: LifecycleState,
      record: WorkspaceRecord
    ) {
      if (!readyWriteFailed && runner.manifestPublicationAttempts > 0 && record.phase === "ready") {
        readyWriteFailed = true;
        throw new Error("injected ready write failure");
      }
      if (readyWriteFailed && record.phase === "setup-error") {
        throw new Error("injected setup-error write failure");
      }
      await writeWorkspace.call(this, record);
    });

    // When
    const updating = updateWorkspace(runner, options(root), workspace.name);

    // Then
    await expect(updating).rejects.toMatchObject({
      message: "workspace update at ready-state publication: injected ready write failure",
      cause: expect.objectContaining({
        message: "injected ready write failure",
        errors: [
          expect.objectContaining({ message: "injected ready write failure" }),
          expect.objectContaining({ message: "injected setup-error write failure" })
        ]
      })
    });
  });

  it("keeps the Project setup failure authoritative when setup-error publication fails", async () => {
    // Given
    runner = new UpdateRunner(0, 17);
    runner.containerRootSnapshotPath = join(root, "assets", "project-roots", workspace.projectId, workspace.rootCommit);
    const writeWorkspace = LifecycleState.prototype.writeWorkspace;
    vi.spyOn(LifecycleState.prototype, "writeWorkspace").mockImplementation(async function (
      this: LifecycleState,
      record: WorkspaceRecord
    ) {
      if (record.phase === "setup-error") throw new Error("injected setup-error write failure");
      await writeWorkspace.call(this, record);
    });

    // When
    const updating = updateWorkspace(runner, options(root), workspace.name);

    // Then
    await expect(updating).rejects.toMatchObject({
      message: "workspace update at Project setup: project setup exited with 17",
      cause: expect.objectContaining({
        message: "project setup exited with 17",
        errors: [
          expect.objectContaining({ message: "project setup exited with 17" }),
          expect.objectContaining({ message: "injected setup-error write failure" })
        ]
      })
    });
  });
});
