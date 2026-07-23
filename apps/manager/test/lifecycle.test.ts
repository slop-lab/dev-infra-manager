import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lifecycleOptions } from "../src/lifecycleOptions.js";
import { LifecycleState, validateLifecycleName } from "../src/lifecycleState.js";
import type { RepoRecord, WorkspaceRecord } from "../src/lifecycleTypes.js";
import { workspaceContainerArgs } from "../src/workspaceLifecycle.js";

describe("repo and workspace lifecycle", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-lifecycle-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("claims workspace names atomically and preserves role-neutral repo records", async () => {
    const state = new LifecycleState(root);
    const now = new Date().toISOString();
    const service = {
      phase: "creating" as const,
      containerName: "dim-gitea",
      networkName: "dim-control",
      volumeName: "dim-gitea-data",
      image: "gitea/gitea:1.27.0",
      port: 3300,
      createdAt: now,
      updatedAt: now
    };
    await state.claimGiteaService(service);
    expect(await state.readGiteaService()).toEqual(service);
    const repo: RepoRecord = {
      name: "project",
      owner: "dim-admin",
      cloneUrl: "http://dim-gitea:3000/dim-admin/project.git",
      sourcePath: "/import/project.git",
      phase: "ready",
      protectedPatterns: ["main"],
      registeredAt: now,
      updatedAt: now
    };
    await state.claimRepo(repo);
    expect(await state.listRepos()).toEqual([repo]);
    expect(JSON.stringify(await state.readRepo("project"))).not.toMatch(/secret|product|control/);

    const workspace: WorkspaceRecord = {
      name: "work-1",
      repo: "project",
      phase: "creating",
      containerName: "dim-ws-work-1",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-1-docker",
      routes: [],
      createdAt: now,
      updatedAt: now
    };
    await state.claimWorkspace(workspace);
    await expect(state.claimWorkspace(workspace)).rejects.toThrow(/already exists/);
    const release = await state.acquireWorkspaceLock("work-1");
    let secondAcquired = false;
    const second = state.acquireWorkspaceLock("work-1").then(async (releaseSecond) => {
      secondAcquired = true;
      await releaseSecond();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondAcquired).toBe(false);
    await release();
    await second;
    expect(secondAcquired).toBe(true);
  });

  it("builds a persistent container with credentials but no host mounts or socket", () => {
    const options = lifecycleOptions({
      DIM_STATE_ROOT: root,
      DIM_WORKSPACE_RUNTIME: "runc",
      DIM_WORKSPACE_PRIVILEGED: "yes"
    });
    const now = new Date().toISOString();
    const record: WorkspaceRecord = {
      name: "work-1",
      repo: "project",
      phase: "creating",
      containerName: "dim-ws-work-1",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-1-docker",
      routes: [],
      createdAt: now,
      updatedAt: now
    };
    const args = workspaceContainerArgs(options, record, {
      username: "writer",
      token: "token",
      userName: "Agent",
      userEmail: "agent@example.invalid"
    });
    expect(args).toEqual(expect.arrayContaining([
      "--name", "dim-ws-work-1",
      "--label", "dim.managed=true",
      "--label", "dim.repo=project",
      "--mount", "type=volume,source=dim-ws-work-1-docker,target=/var/lib/docker",
      "--env", "DIM_GIT_USERNAME=writer",
      "--env", "DIM_GIT_TOKEN=token",
      "--env", "GIT_CONFIG_VALUE_0=Agent",
      "--privileged"
    ]));
    expect(args).not.toContain("--rm");
    expect(args.join(" ")).not.toContain("type=bind");
    expect(args.join(" ")).not.toContain("docker.sock");
  });

  it("validates names and container-only option overrides", () => {
    expect(validateLifecycleName("repo-1", "repo")).toBe("repo-1");
    expect(() => validateLifecycleName("../repo", "repo")).toThrow(/repo name/);
    const options = lifecycleOptions({
      DIM_STATE_ROOT: root,
      DIM_GITEA_PORT: "4300",
      DIM_WORKSPACE_MEMORY: "2g"
    });
    expect(options.giteaPort).toBe(4300);
    expect(options.memory).toBe("2g");
    expect(options.giteaImage).toBe("gitea/gitea:1.27.0");
  });
});
