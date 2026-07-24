import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lifecycleOptions } from "../src/lifecycleOptions.js";
import { LifecycleState, validateLifecycleName } from "../src/lifecycleState.js";
import type { RepoRecord, WorkspaceRecord } from "../src/lifecycleTypes.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../src/types.js";
import { validateWorkspaceProfiles, waitForInnerDocker, workspaceContainerArgs } from "../src/workspaceLifecycle.js";

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
      project: "project",
      projectPath: "/workspace/project",
      phase: "creating",
      profiles: ["development"],
      composeProjectName: "dim-work-1",
      containerName: "dim-ws-work-1",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-1-docker",
      routes: [],
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
      gitBaseUrl: "http://172.20.0.2:3000",
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

    const releaseSetup = await state.acquireWorkspaceSetupLock("work-1");
    const releaseReconciliation = await state.acquireWorkspaceLock("work-1");
    let secondSetupAcquired = false;
    const secondSetup = state.acquireWorkspaceSetupLock("work-1").then(async (releaseSecond) => {
      secondSetupAcquired = true;
      await releaseSecond();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondSetupAcquired).toBe(false);
    await releaseReconciliation();
    expect(secondSetupAcquired).toBe(false);
    await releaseSetup();
    await secondSetup;
    expect(secondSetupAcquired).toBe(true);
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
      project: "project",
      projectPath: "/workspace/project",
      phase: "creating",
      profiles: [],
      composeProjectName: "dim-work-1",
      containerName: "dim-ws-work-1",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-1-docker",
      routes: [],
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
      gitBaseUrl: "http://172.20.0.2:3000",
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
      "--label", "dim.project=project",
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
    expect(options.workspaceImage).toBe("dev-infra-project-workspace:latest");
    expect(validateWorkspaceProfiles(["development", "secrets"])).toEqual(["development", "secrets"]);
    expect(() => validateWorkspaceProfiles(["development", "development"])).toThrow(/duplicated/);
    expect(() => validateWorkspaceProfiles(["bad,profile"])).toThrow(/workspace profile/);
  });

  it("normalizes legacy workspace records without moving their checkout", async () => {
    const state = new LifecycleState(root);
    const now = new Date().toISOString();
    await mkdir(join(root, "workspaces"), { recursive: true });
    await writeFile(join(root, "workspaces", "legacy.json"), JSON.stringify({
      name: "legacy",
      repo: "project",
      phase: "ready",
      containerName: "dim-ws-legacy",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-legacy-docker",
      routes: [],
      createdAt: now,
      updatedAt: now
    }));

    const normalized = await state.readWorkspace("legacy");
    expect(normalized).toMatchObject({
      project: "project",
      projectPath: "/workspace/repos/project",
      profiles: [],
      composeProjectName: "dim-legacy",
      gitUserName: "dim/legacy",
      gitUserEmail: "legacy@dim.invalid",
      gitBaseUrl: "http://dim-gitea:3000"
    });
    await state.writeWorkspace(normalized);
    expect(await readFile(join(root, "workspaces", "legacy.json"), "utf8")).not.toContain('"repo"');
  });

  it("reports stopped workspace state and entrypoint logs when inner Docker fails", async () => {
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command: string, args: string[], _options?: RunOptions): Promise<CommandResult> {
        calls.push([command, ...args]);
        if (args[0] === "exec") {
          return { command, args, stdout: "", stderr: "container is not running", exitCode: 1 };
        }
        if (args[0] === "inspect" && args[2] === "{{json .State}}") {
          return {
            command,
            args,
            stdout: JSON.stringify({ Running: false, Status: "exited" }),
            stderr: "",
            exitCode: 0
          };
        }
        if (args[0] === "inspect") {
          return {
            command,
            args,
            stdout: 'status=exited exitCode=1 oomKilled=false error=""\n',
            stderr: "",
            exitCode: 0
          };
        }
        return { command, args, stdout: "dockerd mount failure\n", stderr: "", exitCode: 0 };
      },
      async runStreaming(): Promise<number> {
        return 0;
      }
    };

    await expect(waitForInnerDocker(runner, "dim-ws-failed")).rejects.toThrow(
      /status=exited exitCode=1 oomKilled=false[\s\S]*dockerd mount failure/
    );
    expect(calls.filter(([, subcommand]) => subcommand === "exec")).toHaveLength(1);
    expect(calls.at(-1)).toEqual(["docker", "logs", "dim-ws-failed"]);
  });
});
