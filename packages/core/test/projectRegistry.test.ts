import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { LifecycleOptions, ProjectRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { ensureGitea, giteaRequest } from "../../../../core/packages/core/src/gitea.js";
import {
  branchProtectionOptions,
  createProjectRepository,
  deleteProjectRepository,
  giteaRepositoryCreationOptions,
  normalizeRepositoryRef,
  prepareHostGitCredential,
  prepareProjectRepositoryTransfer,
  projectNamespace
} from "../../../../core/packages/core/src/projectRegistry.js";
import { RecordingRunner } from "../../../../core/packages/core/src/runner.js";
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

describe("project registry", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });
  it("derives reserved managed namespaces", () => {
    expect(projectNamespace("acme")).toBe("dim-acme");
    expect(() => projectNamespace("../acme")).toThrow(/project name/);
  });

  it("returns the configured host URL with the maintainer credential", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-host-git-credential-"));
    cleanup.push(stateRoot);
    const credential = await prepareHostGitCredential(
      new RecordingRunner(),
      { stateRoot } as LifecycleOptions
    );
    expect(credential).toEqual({
      username: "maintainer",
      password: "secret",
      baseUrl: "https://git.host.example/gitea"
    });
  });

  it("centralizes new managed issue trackers on the project root", () => {
    expect(giteaRepositoryCreationOptions("root", true)).toMatchObject({
      name: "root",
      has_issues: true
    });
    expect(giteaRepositoryCreationOptions("component", false)).toMatchObject({
      name: "component",
      has_issues: false
    });
  });

  it("normalizes repository branches, tags, pull refs, and commits", () => {
    expect(normalizeRepositoryRef("main")).toBe("refs/heads/main");
    expect(normalizeRepositoryRef("refs/heads/release/next")).toBe("refs/heads/release/next");
    expect(normalizeRepositoryRef("refs/tags/v1")).toBe("refs/tags/v1");
    expect(normalizeRepositoryRef("refs/pull/12/head")).toBe("refs/pull/12/head");
    expect(normalizeRepositoryRef("a".repeat(40))).toBe("a".repeat(40));
    expect(() => normalizeRepositoryRef("bad..ref")).toThrow(/repository ref/);
  });

  it("allows only the host maintainer to push protected refs", () => {
    const options = branchProtectionOptions({
      adminUsername: "dim-admin",
      maintainerUsername: "dim-host"
    });
    expect(options).toMatchObject({
      enable_push: true,
      enable_push_whitelist: true,
      push_whitelist_usernames: ["dim-host"],
      push_whitelist_teams: ["Owners"],
      enable_force_push: false,
      merge_whitelist_usernames: ["dim-admin"],
      merge_whitelist_teams: ["Owners"],
      block_admin_merge_override: false
    });
    expect(JSON.stringify(options)).not.toContain("dim-workspace");
  });

  it("allows ordinary pushes while blocking force pushes for baseline protection", () => {
    expect(branchProtectionOptions({
      adminUsername: "dim-admin",
      maintainerUsername: "dim-host"
    }, "no-force-push")).toMatchObject({
      enable_push: true,
      enable_push_whitelist: false,
      enable_force_push: false,
      enable_merge_whitelist: false,
      required_approvals: 0
    });
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

  it("promotes an existing matching repository to the project root", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-project-root-"));
    cleanup.push(stateRoot);
    const state = new LifecycleState(stateRoot);
    const now = new Date().toISOString();
    const source = "https://github.com/example/project.git";
    await state.claimProject({
      schemaVersion: 4,
      id: "project-id",
      name: "example",
      gitNamespace: "dim-example",
      giteaOrganizationId: 41,
      phase: "ready",
      repositories: [{
        alias: "root",
        providerRepoId: "dim-example/root",
        owner: "dim-example",
        hostUrl: "http://127.0.0.1:3300/dim-example/root.git",
        workspaceUrl: "http://dim-gitea:3000/dim-example/root.git",
        phase: "ready",
        connections: [{ name: "origin", url: source }],
        protectedPatterns: [],
        protectionPhase: "applied",
        createdAt: now,
        updatedAt: now
      }],
      createdAt: now,
      updatedAt: now
    });

    await prepareProjectRepositoryTransfer(
      new RecordingRunner(),
      { stateRoot } as LifecycleOptions,
      {
        project: "example",
        alias: "root",
        source,
        root: true,
        ref: "main",
        protectedPatterns: []
      }
    );

    const project = await state.readProject("example");
    expect(project.rootRepositoryAlias).toBe("root");
    expect(project.rootRef).toBe("refs/heads/main");
  });

  it("updates reviewed publish policy without reimporting the repository", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-project-publish-"));
    cleanup.push(stateRoot);
    const state = new LifecycleState(stateRoot);
    const now = new Date().toISOString();
    const source = "https://github.com/example/project.git";
    await state.claimProject({
      schemaVersion: 4,
      id: "project-id",
      name: "example",
      gitNamespace: "dim-example",
      giteaOrganizationId: 41,
      phase: "ready",
      repositories: [{
        alias: "root",
        providerRepoId: "dim-example/root",
        owner: "dim-example",
        hostUrl: "http://127.0.0.1:3300/dim-example/root.git",
        workspaceUrl: "http://dim-gitea:3000/dim-example/root.git",
        phase: "ready",
        connections: [{ name: "origin", url: source }],
        protectedPatterns: [],
        protectionPhase: "applied",
        createdAt: now,
        updatedAt: now
      }],
      createdAt: now,
      updatedAt: now
    });

    const prepared = await prepareProjectRepositoryTransfer(
      new RecordingRunner(),
      { stateRoot } as LifecycleOptions,
      {
        project: "example",
        alias: "root",
        source,
        root: false,
        protectedPatterns: [],
        publishBranches: { main: "development" }
      }
    );

    expect(prepared.transferId).toBeUndefined();
    expect((await state.readProject("example")).repositories[0]?.connections[0]?.publishBranches)
      .toEqual({ main: "development" });
  });

  it.each([
    ["ordinary creation", createProjectRepository],
    ["source-free transfer preparation", prepareProjectRepositoryTransfer]
  ])("removes a stale transfer ID during %s", async (_name, transition) => {
    // Given
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-project-transfer-id-"));
    cleanup.push(stateRoot);
    const state = new LifecycleState(stateRoot);
    const now = new Date().toISOString();
    await state.claimProject({
      schemaVersion: 4, id: "project-id", name: "example", gitNamespace: "dim-example", giteaOrganizationId: 41, phase: "ready",
      repositories: [{
        alias: "repo", providerRepoId: "dim-example/repo", owner: "dim-example",
        hostUrl: "http://host/dim-example/repo.git", workspaceUrl: "http://gitea/dim-example/repo.git",
        phase: "error", transferId: "stale-transfer", error: "failed", connections: [],
        protectedPatterns: [], protectionPhase: "pending", createdAt: now, updatedAt: now
      }],
      createdAt: now, updatedAt: now
    });

    // When
    await transition(new RecordingRunner(), { stateRoot } as LifecycleOptions, {
      project: "example", alias: "repo", root: false, protectedPatterns: []
    });

    // Then
    expect((await state.readProject("example")).repositories[0]).not.toHaveProperty("transferId");
  });
});
