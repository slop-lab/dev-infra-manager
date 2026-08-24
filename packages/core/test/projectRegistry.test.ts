import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { LifecycleOptions, ProjectRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import {
  branchProtectionOptions,
  deleteProjectRepository,
  normalizeRepositoryRef,
  prepareProjectRepositoryTransfer,
  projectNamespace
} from "../../../../core/packages/core/src/projectRegistry.js";
import { RecordingRunner } from "../../../../core/packages/core/src/runner.js";

describe("project registry", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("derives reserved managed namespaces", () => {
    expect(projectNamespace("acme")).toBe("dim-acme");
    expect(() => projectNamespace("../acme")).toThrow(/project name/);
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
      enable_force_push: false,
      merge_whitelist_usernames: ["dim-admin"]
    });
    expect(JSON.stringify(options)).not.toContain("dim-workspace");
  });

  it("rejects deleting the project root repository", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-project-registry-"));
    cleanup.push(stateRoot);
    const state = new LifecycleState(stateRoot);
    const now = new Date().toISOString();
    const repository = (alias: string) => ({
      alias,
      providerRepoId: `dim-example/${alias}`,
      owner: "dim-example",
      hostUrl: `http://127.0.0.1:3300/dim-example/${alias}.git`,
      workspaceUrl: `http://dim-gitea:3000/dim-example/${alias}.git`,
      phase: "ready" as const,
      connections: [],
      protectedPatterns: [],
      protectionPhase: "applied" as const,
      createdAt: now,
      updatedAt: now
    });
    const project: ProjectRecord = {
      schemaVersion: 3,
      id: "project-id",
      name: "example",
      gitNamespace: "dim-example",
      phase: "ready",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      repositories: [repository("root"), repository("extra")],
      createdAt: now,
      updatedAt: now
    };
    await state.claimProject(project);
    const options = { stateRoot } as LifecycleOptions;

    await expect(deleteProjectRepository(new RecordingRunner(), options, "example", "root")).rejects.toThrow(
      "is the project root"
    );
  });

  it("promotes an existing matching repository to the project root", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-project-root-"));
    cleanup.push(stateRoot);
    const state = new LifecycleState(stateRoot);
    const now = new Date().toISOString();
    const source = "https://github.com/example/project.git";
    await state.claimProject({
      schemaVersion: 3,
      id: "project-id",
      name: "example",
      gitNamespace: "dim-example",
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
      schemaVersion: 3,
      id: "project-id",
      name: "example",
      gitNamespace: "dim-example",
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
});
