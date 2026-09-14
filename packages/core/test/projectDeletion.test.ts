import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { RecordingRunner } from "../../../../core/packages/core/src/runner.js";
import { Barrier, lifecycleOptions, project } from "./projectDeletionFixture.js";

const seams = vi.hoisted(() => ({
  inspectSnapshotState: false,
  snapshotFailures: new Array<Error>(),
  snapshotProjectIds: new Array<string>(),
  giteaStatuses: new Array<number>(),
  giteaOrganizationBodies: new Array<unknown>(),
  giteaRequests: new Array<string>()
}));

vi.mock("../../../../core/packages/core/src/protectedRootSnapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../core/packages/core/src/protectedRootSnapshot.js")>();
  return {
    ...actual,
    removeProtectedRootSnapshots: vi.fn(async (stateRoot: string, projectId: string) => {
      if (seams.inspectSnapshotState) {
        const project = await new LifecycleState(stateRoot).readProject("project");
        expect(project.id).toBe(projectId);
        seams.snapshotProjectIds.push(project.id);
      }
      const failure = seams.snapshotFailures.shift();
      if (failure !== undefined) throw failure;
      await actual.removeProtectedRootSnapshots(stateRoot, projectId);
    })
  };
});

vi.mock("../../../../core/packages/core/src/gitea.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/gitea.js")>(),
  ensureGitea: vi.fn(async () => ({
    adminUsername: "admin",
    adminPassword: "secret",
    writerUsername: "writer",
    writerPassword: "secret",
    maintainerUsername: "maintainer",
    maintainerPassword: "secret",
    apiBaseUrl: "http://gitea.invalid/api/v1"
  })),
  giteaRequest: vi.fn(async (_connection, method: string, path: string) => {
    seams.giteaRequests.push(`${method} ${path}`);
    const status = seams.giteaStatuses.shift() ?? (method === "GET" ? 200 : 204);
    const body = method === "GET" && status === 200
      ? JSON.stringify(seams.giteaOrganizationBodies.shift() ?? { id: 41, username: "dim-project" })
      : null;
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  })
}));

import { purgeProject, removeProject } from "../../../../core/packages/core/src/projectRegistry.js";

describe("Project deletion", () => {
  let stateRoot = "";
  let state = new LifecycleState("/uninitialized");
  let options = lifecycleOptions("/uninitialized");
  let snapshotPath = "";

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "dim-project-deletion-"));
    state = new LifecycleState(stateRoot);
    options = lifecycleOptions(stateRoot);
    await state.claimProject(project);
    snapshotPath = join(stateRoot, "assets", "project-roots", project.id, "commit");
    await mkdir(snapshotPath, { recursive: true });
    seams.inspectSnapshotState = false;
    seams.snapshotFailures.length = 0;
    seams.snapshotProjectIds.length = 0;
    seams.giteaStatuses.length = 0;
    seams.giteaOrganizationBodies.length = 0;
    seams.giteaRequests.length = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("retains readable Project state when removal snapshot cleanup fails, then retries", async () => {
    // Given
    const cleanupFailure = new Error("snapshot cleanup failed");
    seams.inspectSnapshotState = true;
    seams.snapshotFailures.push(cleanupFailure);

    // When / Then
    await expect(removeProject(options, project.name)).rejects.toBe(cleanupFailure);
    expect(seams.snapshotProjectIds).toEqual([project.id]);
    await expect(state.readProject(project.name)).resolves.toEqual(project);
    await expect(stat(snapshotPath)).resolves.toBeDefined();
    await expect(removeProject(options, project.name)).resolves.toBeUndefined();
    expect(seams.snapshotProjectIds).toEqual([project.id, project.id]);
    await expect(stat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(state.readProject(project.name)).rejects.toThrow(/not found/);
  });

  it("retains state after Gitea cleanup fails at snapshots and accepts 404 on retry", async () => {
    // Given
    const cleanupFailure = new Error("snapshot cleanup failed");
    seams.inspectSnapshotState = true;
    seams.snapshotFailures.push(cleanupFailure);
    seams.giteaStatuses.push(200, 204, 204, 404);

    // When / Then
    await expect(purgeProject(new RecordingRunner(), options, project.name)).rejects.toBe(cleanupFailure);
    expect(seams.snapshotProjectIds).toEqual([project.id]);
    await expect(state.readProject(project.name)).resolves.toEqual(project);
    await expect(stat(snapshotPath)).resolves.toBeDefined();
    await expect(purgeProject(new RecordingRunner(), options, project.name)).resolves.toBeUndefined();
    expect(seams.giteaRequests).toEqual([
      "GET /orgs/dim-project",
      "DELETE /repos/dim-project/root",
      "DELETE /orgs/dim-project",
      "GET /orgs/dim-project"
    ]);
    expect(seams.snapshotProjectIds).toEqual([project.id, project.id]);
    await expect(stat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(state.readProject(project.name)).rejects.toThrow(/not found/);
  });

  it("rejects a mismatched organization identity before destructive purge requests", async () => {
    // Given
    seams.giteaOrganizationBodies.push({ id: 42, username: "dim-project" });

    // When
    const purge = purgeProject(new RecordingRunner(), options, project.name);

    // Then
    await expect(purge).rejects.toThrow(/organization identity/);
    expect(seams.giteaRequests).toEqual(["GET /orgs/dim-project"]);
    await expect(state.readProject(project.name)).resolves.toEqual(project);
    await expect(stat(snapshotPath)).resolves.toBeDefined();
  });

  it.each([
    ["remove", () => removeProject(options, project.name)],
    ["purge", () => purgeProject(new RecordingRunner(), options, project.name)]
  ])("acquires Project then CI-runner locks and releases them in reverse for %s", async (_name, deletion) => {
    // Given
    const events: string[] = [];
    const acquireProjectLock = LifecycleState.prototype.acquireProjectLock;
    const acquireCiRunnerLock = LifecycleState.prototype.acquireCiRunnerLock;
    vi.spyOn(LifecycleState.prototype, "acquireProjectLock").mockImplementation(async function (
      this: LifecycleState,
      name: string
    ) {
      events.push("project:lock");
      const release = await acquireProjectLock.call(this, name);
      return async () => { events.push("project:unlock"); await release(); };
    });
    vi.spyOn(LifecycleState.prototype, "acquireCiRunnerLock").mockImplementation(async function (
      this: LifecycleState,
      name: string
    ) {
      events.push("ci-runner:lock");
      const release = await acquireCiRunnerLock.call(this, name);
      return async () => { events.push("ci-runner:unlock"); await release(); };
    });

    // When
    await deletion();

    // Then
    expect(events).toEqual([
      "project:lock",
      "ci-runner:lock",
      "ci-runner:unlock",
      "project:unlock"
    ]);
  });

  it.each([
    ["remove", () => removeProject(options, project.name)],
    ["purge", () => purgeProject(new RecordingRunner(), options, project.name)]
  ])("rejects %s while a repository transfer is active", async (_name, deletion) => {
    // Given
    const projectLock = vi.spyOn(LifecycleState.prototype, "acquireProjectLock");
    const ciRunnerLock = vi.spyOn(LifecycleState.prototype, "acquireCiRunnerLock");
    await state.writeProject({
      ...project,
      repositories: project.repositories.map((repository) => ({
        ...repository,
        phase: "importing",
        transferId: "active-transfer"
      }))
    });

    // When / Then
    await expect(deletion()).rejects.toThrow(
      "project 'project' has active repository transfer for repo 'root'"
    );
    await expect(state.readProject(project.name)).resolves.toMatchObject({ phase: "ready" });
    expect(seams.giteaRequests).toEqual([]);
    expect(projectLock).toHaveBeenCalledBefore(ciRunnerLock);
  });

  it("cannot check Project usage while admitted reconciliation holds the CI-runner lock", async () => {
    // Given
    const admitted = new LifecycleState(stateRoot);
    const releaseProject = await admitted.acquireProjectLock(project.name);
    const releaseCiRunner = await admitted.acquireCiRunnerLock(project.name);
    await releaseProject();
    const ciRunnerAttempted = new Barrier();
    const usageChecked = new Barrier();
    const acquireCiRunnerLock = LifecycleState.prototype.acquireCiRunnerLock;
    const listCiRunners = LifecycleState.prototype.listCiRunners;
    vi.spyOn(LifecycleState.prototype, "acquireCiRunnerLock").mockImplementation(function (
      this: LifecycleState,
      name: string
    ) {
      ciRunnerAttempted.open();
      return acquireCiRunnerLock.call(this, name);
    });
    vi.spyOn(LifecycleState.prototype, "listCiRunners").mockImplementation(function (this: LifecycleState) {
      usageChecked.open();
      return listCiRunners.call(this);
    });

    // When
    const deletion = removeProject(options, project.name);
    const first = await Promise.race([
      ciRunnerAttempted.promise.then(() => "ci-runner-lock" as const),
      usageChecked.promise.then(() => "usage-check" as const)
    ]);
    await releaseCiRunner();
    await deletion;

    // Then
    expect(first).toBe("ci-runner-lock");
  });
});
