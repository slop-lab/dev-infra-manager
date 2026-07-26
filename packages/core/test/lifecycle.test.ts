import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lifecycleOptions } from "../src/lifecycleOptions.js";
import { LifecycleState, validateLifecycleName } from "../src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../src/lifecycleTypes.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../src/types.js";
import { validateWorkspaceProfiles, waitForInnerDocker, workspaceContainerArgs } from "../src/workspaceLifecycle.js";
import { workspaceRuntimePlan } from "../src/runtimeBackends.js";

describe("project and workspace lifecycle", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-lifecycle-"));
    await writeFile(
      join(root, "dim.json"),
      JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" })
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("claims project and workspace names atomically", async () => {
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
    const project: ProjectRecord = {
      schemaVersion: 2,
      id: "project-id",
      name: "project",
      gitNamespace: "dim-project",
      phase: "ready",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      repositories: [{
        alias: "root",
        providerRepoId: "dim-project/root",
        owner: "dim-project",
        hostUrl: "http://127.0.0.1:3300/dim-project/root.git",
        workspaceUrl: "http://dim-gitea:3000/dim-project/root.git",
        phase: "ready",
        protectedPatterns: ["main"],
        protectionPhase: "applied",
        createdAt: now,
        updatedAt: now
      }],
      createdAt: now,
      updatedAt: now
    };
    await state.claimProject(project);
    expect(await state.listProjects()).toEqual([project]);

    const workspace: WorkspaceRecord = {
      schemaVersion: 2,
      name: "work-1",
      projectId: project.id,
      projectName: project.name,
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      projectPath: "/workspace/project",
      phase: "creating",
      profiles: ["development"],
      composeProjectName: "dim-work-1",
      containerName: "dim-ws-work-1",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-1-docker",
      runtimeBackend: "runc",
      cpuCount: "2",
      memory: "4g",
      pidsLimit: "2048",
      routes: [],
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
      gitBaseUrl: "http://172.20.0.2:3000/dim-project",
      projectManifestPath: "/run/dim/project.json",
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
      DIM_CONFIG_PATH: join(root, "dim.json"),
      DIM_WORKSPACE_RUNTIME: "runc",
      DIM_WORKSPACE_PRIVILEGED: "yes"
    });
    const now = new Date().toISOString();
    const record: WorkspaceRecord = {
      schemaVersion: 2,
      name: "work-1",
      projectId: "project-id",
      projectName: "project",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      projectPath: "/workspace/project",
      phase: "creating",
      profiles: [],
      composeProjectName: "dim-work-1",
      containerName: "dim-ws-work-1",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-1-docker",
      runtimeBackend: "runc",
      cpuCount: "1.5",
      memory: "3g",
      pidsLimit: "1024",
      routes: [],
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
      gitBaseUrl: "http://172.20.0.2:3000/dim-project",
      projectManifestPath: "/run/dim/project.json",
      createdAt: now,
      updatedAt: now
    };
    const args = workspaceContainerArgs(options, record, {
      username: "writer",
      token: "token",
      userName: "Agent",
      userEmail: "agent@example.invalid"
    }, "work-1.external-url-grant");
    expect(args).toEqual(expect.arrayContaining([
      "--name", "dim-ws-work-1",
      "--label", "dim.managed=true",
      "--label", "dim.project=project",
      "--label", "dim.repo=root",
      "--mount", "type=volume,source=dim-ws-work-1-docker,target=/var/lib/docker",
      "--cpus", "1.5",
      "--memory", "3g",
      "--pids-limit", "1024",
      "--env", "DIM_GIT_USERNAME=writer",
      "--env", "DIM_GIT_TOKEN=token",
      "--add-host", "host.docker.internal:host-gateway",
      "--env", "DIM_CONTROLLER_API=http://host.docker.internal:7070",
      "--env", "DIM_CONTROLLER_TOKEN=work-1.external-url-grant",
      "--env", "GIT_CONFIG_VALUE_0=Agent",
      "--privileged"
    ]));
    expect(args).not.toContain("--rm");
    expect(args.join(" ")).not.toContain("type=bind");
    expect(args.join(" ")).not.toContain("docker.sock");
  });

  it("creates and authenticates a workspace-scoped external URL grant", async () => {
    const state = new LifecycleState(root);
    const now = new Date().toISOString();
    const record: WorkspaceRecord = {
      schemaVersion: 2,
      name: "work-1",
      projectId: "project-id",
      projectName: "project",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      projectPath: "/workspace/project",
      phase: "ready",
      profiles: [],
      composeProjectName: "dim-work-1",
      containerName: "dim-ws-work-1",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-1-docker",
      runtimeBackend: "runc",
      cpuCount: "2",
      memory: "4g",
      pidsLimit: "2048",
      routes: [],
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
      gitBaseUrl: "http://dim-gitea:3000/dim-project",
      projectManifestPath: "/run/dim/project.json",
      createdAt: now,
      updatedAt: now
    };
    await state.claimWorkspace(record);
    const grant = await state.ensureWorkspaceGrant(record.name);
    expect(grant).toMatch(/^work-1\./);
    expect(await state.ensureWorkspaceGrant(record.name)).toBe(grant);
    expect(await state.authenticateWorkspaceGrant(grant)).toEqual(record);
    expect(await state.authenticateWorkspaceGrant(`${grant}x`)).toBeUndefined();
    await state.removeWorkspaceGrant(record.name);
    expect(await state.authenticateWorkspaceGrant(grant)).toBeUndefined();
  });

  it("validates names and container-only option overrides", () => {
    expect(validateLifecycleName("repo-1", "repo")).toBe("repo-1");
    expect(() => validateLifecycleName("../repo", "repo")).toThrow(/repo name/);
    expect(() => lifecycleOptions({ DIM_CONFIG_PATH: join(root, "missing.json") })).toThrow(
      /workspace backend is not configured/
    );
    const options = lifecycleOptions({
      DIM_STATE_ROOT: root,
      DIM_CONFIG_PATH: join(root, "dim.json"),
      DIM_GITEA_PORT: "4300",
      DIM_WORKSPACE_MEMORY: "2g"
    });
    expect(options.giteaPort).toBe(4300);
    expect(options.memory).toBe("2g");
    expect(options.giteaImage).toBe("gitea/gitea:1.27.0");
    expect(options.defaultWorkspaceBackend).toBe("sysbox");
    expect(validateWorkspaceProfiles(["development", "secrets"])).toEqual(["development", "secrets"]);
    expect(() => validateWorkspaceProfiles(["development", "development"])).toThrow(/duplicated/);
    expect(() => validateWorkspaceProfiles(["bad,profile"])).toThrow(/workspace profile/);
  });

  it("selects persistent workspace runtime backends", () => {
    const options = lifecycleOptions({ DIM_STATE_ROOT: root, DIM_CONFIG_PATH: join(root, "dim.json") });
    expect(workspaceRuntimePlan("sysbox", options)).toMatchObject({
      dockerRuntime: "sysbox-runc",
      image: "dev-infra-project-workspace:latest",
      privileged: false,
      engine: "docker"
    });
    expect(workspaceRuntimePlan("gvisor", options)).toMatchObject({
      dockerRuntime: "runsc",
      privileged: false,
      env: { DIM_DOCKERD_FLAGS: "--feature containerd-snapshotter=false" }
    });
    expect(workspaceRuntimePlan("rootless-podman", options)).toMatchObject({
      image: "dev-infra-project-workspace-podman:latest",
      runtimeDataPath: "/home/dim/.local/share/containers",
      engine: "podman",
      privileged: false,
      capabilities: expect.arrayContaining(["SYS_ADMIN", "SETUID", "SETGID", "SYS_CHROOT"]),
      securityOptions: [
        "seccomp=unconfined",
        "apparmor=unconfined",
        "systempaths=unconfined"
      ],
      devices: ["/dev/fuse"]
    });
    expect(workspaceRuntimePlan("runc", options)).toMatchObject({
      dockerRuntime: "runc",
      privileged: true,
      engine: "docker"
    });
  });

  it("rejects legacy workspace records without modifying them", async () => {
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

    await expect(state.readWorkspace("legacy")).rejects.toThrow(/does not migrate existing state/);
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
      /nested docker did not become ready[\s\S]*status=exited exitCode=1 oomKilled=false[\s\S]*dockerd mount failure/
    );
    expect(calls.filter(([, subcommand]) => subcommand === "exec")).toHaveLength(1);
    expect(calls.at(-1)).toEqual(["docker", "logs", "dim-ws-failed"]);
  });
});
