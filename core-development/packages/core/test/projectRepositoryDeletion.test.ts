import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { LifecycleOptions, ProjectRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { deleteProjectRepository } from "../../../../core/packages/core/src/projectRegistry.js";
import { RecordingRunner } from "../../../../core/packages/core/src/runner.js";
import { ensureGitea, giteaRequest } from "../../../../core/packages/core/src/gitea.js";
import { projectRepositoryFixture } from "./projectRegistryFixture.js";

vi.mock("../../../../core/packages/core/src/gitea.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/gitea.js")>(),
  ensureGitea: vi.fn(async () => ({
    kind: "external" as const,
    adminUsername: "admin", adminPassword: "secret",
    writerUsername: "writer", writerPassword: "secret",
    maintainerUsername: "maintainer", maintainerPassword: "secret",
    apiBaseUrl: "http://gitea.invalid/api/v1",
    hostBaseUrl: "https://git.host.example/gitea",
    workspaceBaseUrl: "https://git.workspace.example/gitea",
    runnerBaseUrl: "https://git.runner.example/gitea",
    projectBindings: {}
  })),
  giteaRequest: vi.fn(async () => new Response(null, { status: 204 }))
}));

describe("project repository deletion", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("rejects deleting the project root repository", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-project-registry-"));
    cleanup.push(stateRoot); const state = new LifecycleState(stateRoot);
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      schemaVersion: 4,
      id: "project-id",
      name: "example",
      gitNamespace: "dim-example",
      giteaOrganizationId: 41,
      phase: "ready",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      repositories: [projectRepositoryFixture("root", "ready"), projectRepositoryFixture("extra", "ready")],
      createdAt: now,
      updatedAt: now
    };
    await state.claimProject(project);
    await expect(deleteProjectRepository(new RecordingRunner(), { stateRoot } as LifecycleOptions, "example", "root")).rejects.toThrow(
      "is the project root"
    );
  });

  it("deletes an unused non-root repository from external Gitea", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-project-external-delete-"));
    cleanup.push(stateRoot);
    const state = new LifecycleState(stateRoot);
    const now = new Date().toISOString();
    await state.claimProject({
      schemaVersion: 4,
      id: "project-id",
      name: "example",
      gitNamespace: "dim-example",
      giteaOrganizationId: 41,
      phase: "ready",
      repositories: [projectRepositoryFixture("target", "ready")],
      createdAt: now,
      updatedAt: now
    });
    vi.clearAllMocks();

    await deleteProjectRepository(new RecordingRunner(), {
      stateRoot,
      giteaConnection: { kind: "external", file: "/external.json" }
    } as LifecycleOptions, "example", "target");

    expect(giteaRequest).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "external", adminUsername: "admin" }),
      "DELETE",
      "/repos/dim-example/target"
    );
    expect((await state.readProject("example")).repositories).toEqual([]);
  });

  it("rejects deleting a repository while it is importing without side effects", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-project-importing-delete-"));
    cleanup.push(stateRoot); const state = new LifecycleState(stateRoot);
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      schemaVersion: 4, id: "project-id", name: "example", gitNamespace: "dim-example", giteaOrganizationId: 41, phase: "ready",
      repositories: [{ ...projectRepositoryFixture("target", "importing"), createdAt: now, updatedAt: now }],
      createdAt: now, updatedAt: now
    };
    await state.claimProject(project);
    vi.clearAllMocks();

    await expect(deleteProjectRepository(new RecordingRunner(), { stateRoot } as LifecycleOptions, "example", "target")).rejects.toThrow("is importing");

    expect(ensureGitea).not.toHaveBeenCalled();
    expect(giteaRequest).not.toHaveBeenCalled();
    expect(await state.readProject("example")).toEqual(project);
  });

  it("deletes a ready target when another repository is importing", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-project-sibling-import-"));
    cleanup.push(stateRoot);
    const state = new LifecycleState(stateRoot);
    await state.claimProject({
      schemaVersion: 4, id: "project-id", name: "example", gitNamespace: "dim-example", giteaOrganizationId: 41, phase: "ready",
      repositories: [projectRepositoryFixture("target", "ready"), projectRepositoryFixture("other", "importing")],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    vi.clearAllMocks(); await deleteProjectRepository(new RecordingRunner(), { stateRoot } as LifecycleOptions, "example", "target");

    expect((await state.readProject("example")).repositories.map((repo) => repo.alias)).toEqual(["other"]); expect(giteaRequest).toHaveBeenCalledOnce();
  });
});
