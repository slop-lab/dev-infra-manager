import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lifecycleOptions } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState, validateLifecycleName } from "../../../../core/packages/core/src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import {
  alignWorkspaceRoot,
  detectWorkspaceKvm,
  projectRuntimeManifest,
  resolveWorkspaceKvm,
  restartWorkspace,
  updateWorkspaceResources,
  validateWorkspaceProfiles,
  validateWorkspaceResources,
  waitForInnerDocker,
  workspaceContainerArgs
} from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { workspaceRuntimePlan } from "../../../../core/packages/core/src/runtimeBackends.js";

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
      schemaVersion: 3,
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
        connections: [],
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
      schemaVersion: 3,
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
      kvm: false,
      cpuCount: "2",
      memory: "4g",
      pidsLimit: "2048",
      routes: [],
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
      gitBaseUrl: "http://172.20.0.2:3000/dim-project",
      hostAliases: { "dim-gitea": ["172.20.0.2"] },
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

  it("publishes the actual Project repository catalog without credentials", () => {
    const now = new Date().toISOString();
    const repository = (alias: string, phase: "ready" | "error") => ({
      alias,
      providerRepoId: `dim-project/${alias}`,
      owner: "dim-project",
      hostUrl: `http://127.0.0.1:3300/dim-project/${alias}.git`,
      workspaceUrl: `http://dim-gitea:3000/dim-project/${alias}.git`,
      phase,
      connections: [],
      protectedPatterns: [],
      protectionPhase: "applied" as const,
      createdAt: now,
      updatedAt: now
    });
    const project = {
      schemaVersion: 3 as const,
      id: "project-id",
      name: "project",
      gitNamespace: "dim-project",
      phase: "ready" as const,
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      repositories: [repository("source", "ready"), repository("root", "ready"), repository("pending", "error")],
      createdAt: now,
      updatedAt: now
    };
    const workspace = {
      schemaVersion: 3 as const,
      name: "work",
      projectId: project.id,
      projectName: project.name,
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      projectPath: "/workspace/project",
      phase: "ready" as const,
      profiles: [],
      composeProjectName: "dim-work",
      containerName: "dim-ws-work",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-docker",
      runtimeBackend: "runc" as const,
      kvm: false,
      cpuCount: "2",
      memory: "4g",
      pidsLimit: "2048",
      routes: [],
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
      gitBaseUrl: "http://dim-gitea:3000/dim-project",
      hostAliases: {},
      projectManifestPath: "/run/dim/project.json",
      createdAt: now,
      updatedAt: now
    };

    const manifest = projectRuntimeManifest(workspace, project, {
      version: 1,
      status: "unavailable",
      driver: "none",
      controllers: [],
      reason: "test"
    });

    expect(manifest.repositories).toEqual({
      pending: { workspaceUrl: "http://dim-gitea:3000/dim-project/pending.git", phase: "error", root: false },
      root: { workspaceUrl: "http://dim-gitea:3000/dim-project/root.git", phase: "ready", root: true },
      source: { workspaceUrl: "http://dim-gitea:3000/dim-project/source.git", phase: "ready", root: false }
    });
    expect(JSON.stringify(manifest)).not.toContain("token");
    expect(JSON.stringify(manifest)).not.toContain("password");
  });

  it("auto-detects KVM except for the gVisor workspace runtime", async () => {
    await expect(detectWorkspaceKvm("runc", async () => {})).resolves.toBe(true);
    await expect(detectWorkspaceKvm("rootless-podman", async () => {})).resolves.toBe(true);
    await expect(detectWorkspaceKvm("runc", async () => {
      throw new Error("missing");
    })).resolves.toBe(false);
    await expect(detectWorkspaceKvm("gvisor", async () => {})).resolves.toBe(false);
  });

  it("honors explicit workspace KVM policy", async () => {
    await expect(resolveWorkspaceKvm("runc", undefined, async () => {})).resolves.toBe(true);
    await expect(resolveWorkspaceKvm("runc", false, async () => {})).resolves.toBe(false);
    await expect(resolveWorkspaceKvm("runc", true, async () => {})).resolves.toBe(true);
    await expect(resolveWorkspaceKvm("runc", true, async () => {
      throw new Error("missing");
    })).rejects.toThrow(/KVM was requested but is unavailable/);
    await expect(resolveWorkspaceKvm("gvisor", true, async () => {}))
      .rejects.toThrow(/KVM was requested but is unavailable/);
  });

  it("rejects dirty and divergent restarts before stopping or changing workspace state", async () => {
    const state = new LifecycleState(root);
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      schemaVersion: 3,
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
        connections: [],
        protectedPatterns: ["main"],
        protectionPhase: "applied",
        createdAt: now,
        updatedAt: now
      }],
      createdAt: now,
      updatedAt: now
    };
    const workspace: WorkspaceRecord = {
      schemaVersion: 3,
      name: "work-1",
      projectId: project.id,
      projectName: project.name,
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      projectPath: "/workspace/project",
      phase: "ready",
      profiles: ["development"],
      composeProjectName: "dim-work-1",
      containerName: "dim-ws-work-1",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-1-docker",
      runtimeBackend: "runc",
      kvm: false,
      cpuCount: "2",
      memory: "4g",
      pidsLimit: "2048",
      routes: [],
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
      gitBaseUrl: "http://dim-gitea:3000/dim-project",
      hostAliases: { "dim-gitea": ["172.20.0.2"] },
      projectManifestPath: "/run/dim/project.json",
      lastSetup: { startedAt: now, completedAt: now, exitCode: 0 },
      createdAt: now,
      updatedAt: now
    };
    await state.claimProject(project);
    await state.claimWorkspace(workspace);
    const calls: string[][] = [];
    let checkout: "dirty" | "divergent" = "dirty";
    let stopCalls = 0;
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        if (args.includes("{{.State.Running}}")) {
          return { command, args, stdout: "true\n", stderr: "", exitCode: 0 };
        }
        if (args.includes("--porcelain")) {
          return {
            command,
            args,
            stdout: checkout === "dirty" ? " M tracked.txt\n?? untracked.txt\n" : "",
            stderr: "",
            exitCode: 0
          };
        }
        if (args.includes("ls-remote")) {
          return {
            command,
            args,
            stdout: `${"a".repeat(40)}\trefs/heads/main\n`,
            stderr: "",
            exitCode: 0
          };
        }
        if (args.includes("fetch")) return { command, args, stdout: "", stderr: "", exitCode: 0 };
        if (args.includes("merge-base")) return { command, args, stdout: "", stderr: "", exitCode: 1 };
        return { command, args, stdout: "", stderr: "unexpected command", exitCode: 1 };
      },
      async runStreaming() {
        stopCalls += 1;
        return 0;
      }
    };
    const options = lifecycleOptions({ DIM_STATE_ROOT: root, DIM_CONFIG_PATH: join(root, "dim.json") });

    await expect(restartWorkspace(runner, options, workspace.name)).rejects.toThrow(
      /uncommitted project changes.*workspace align work-1 --reset --yes/
    );
    expect(stopCalls).toBe(0);
    expect(calls.some((call) => call.includes("fetch"))).toBe(false);
    expect(await state.readWorkspace(workspace.name)).toEqual(workspace);

    calls.length = 0;
    checkout = "divergent";
    await expect(restartWorkspace(runner, options, workspace.name)).rejects.toThrow(
      /cannot fast-forward.*workspace align work-1 --reset --yes/
    );
    expect(stopCalls).toBe(0);
    expect(calls.some((call) => call.includes("merge"))).toBe(false);
    expect(calls.flat()).not.toContain("FETCH_HEAD");
    expect(calls.some((call) => call.includes("--no-write-fetch-head"))).toBe(true);
    expect(calls.filter((call) => call.includes("merge-base"))).toHaveLength(2);
    expect(await state.readWorkspace(workspace.name)).toEqual(workspace);
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
      schemaVersion: 3,
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
      kvm: true,
      cpuCount: "1.5",
      memory: "3g",
      pidsLimit: "1024",
      routes: [],
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
      gitBaseUrl: "http://172.20.0.2:3000/dim-project",
      hostAliases: { "dim-gitea": ["172.20.0.2"] },
      projectManifestPath: "/run/dim/project.json",
      createdAt: now,
      updatedAt: now
    };
    const args = workspaceContainerArgs(options, record, {
      username: "writer",
      token: "token",
      userName: "Agent",
      userEmail: "agent@example.invalid"
    }, "work-1.controller-grant", () => 992);
    expect(args).toEqual(expect.arrayContaining([
      "--name", "dim-ws-work-1",
      "--label", "dim.managed=true",
      "--label", "dim.project=project",
      "--label", "dim.repo=root",
      "--label", "dim.runtime-config=2",
      "--mount", "type=volume,source=dim-ws-work-1-docker,target=/var/lib/docker",
      "--cpus", "1.5",
      "--memory", "3g",
      "--pids-limit", "1024",
      "--env", "DIM_GIT_USERNAME=writer",
      "--env", "DIM_GIT_TOKEN=token",
      "--add-host", "host.docker.internal:host-gateway",
      "--mount", `type=bind,source=${join(options.controllerSocketPath, "..")},target=/run/dim/controller`,
      "--env", "DIM_CONTROLLER_SOCKET=/run/dim/controller/controller.sock",
      "--env", "DIM_CONTROLLER_TOKEN=work-1.controller-grant",
      "--env", "DIM_REGISTRY_CACHE_ENDPOINT=dim-registry-cache:5000",
      "--env", "GIT_CONFIG_VALUE_0=Agent",
      "--device", "/dev/kvm",
      "--group-add", "992",
      "--privileged"
    ]));
    expect(args).not.toContain("--rm");
    expect(args.join(" ")).not.toContain("docker.sock");
  });

  it("creates and authenticates a workspace-scoped external URL grant", async () => {
    const state = new LifecycleState(root);
    const now = new Date().toISOString();
    const record: WorkspaceRecord = {
      schemaVersion: 3,
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
      kvm: false,
      cpuCount: "2",
      memory: "4g",
      pidsLimit: "2048",
      routes: [],
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
      gitBaseUrl: "http://dim-gitea:3000/dim-project",
      hostAliases: { "dim-gitea": ["172.20.0.2"] },
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
    expect(() => validateWorkspaceResources({
      cpuCount: "0",
      memory: "4g",
      pidsLimit: "2048"
    })).toThrow(/CPU limit/);
    expect(() => validateWorkspaceResources({
      cpuCount: "2",
      memory: "unlimited",
      pidsLimit: "2048"
    })).toThrow(/memory limit/);
  });

  it("updates a claimed workspace container and persists its effective resources", async () => {
    const state = new LifecycleState(root);
    const now = new Date().toISOString();
    const record: WorkspaceRecord = {
      schemaVersion: 3,
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
      kvm: false,
      cpuCount: "2",
      memory: "4g",
      pidsLimit: "2048",
      routes: [],
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
      gitBaseUrl: "http://dim-gitea:3000/dim-project",
      hostAliases: { "dim-gitea": ["172.20.0.2"] },
      projectManifestPath: "/run/dim/project.json",
      createdAt: now,
      updatedAt: now
    };
    await state.claimWorkspace(record);
    const calls: string[][] = [];
    let projectStatus = "";
    const runner: StreamingCommandRunner = {
      async run(command: string, args: string[]): Promise<CommandResult> {
        calls.push([command, ...args]);
        if (args.includes("{{.State.Running}}")) {
          return { command, args, stdout: "true\n", stderr: "", exitCode: 0 };
        }
        if ((args[0] === "container" && args[1] === "inspect") || args[0] === "inspect") {
          return { command, args, stdout: "true|work-1|workspace\n", stderr: "", exitCode: 0 };
        }
        if (args.includes("--porcelain")) {
          return { command, args, stdout: projectStatus, stderr: "", exitCode: 0 };
        }
        return { command, args, stdout: "dim-ws-work-1\n", stderr: "", exitCode: 0 };
      },
      async runStreaming(): Promise<number> {
        return 0;
      }
    };

    const options = lifecycleOptions({ DIM_STATE_ROOT: root, DIM_CONFIG_PATH: join(root, "dim.json") });
    const updated = await updateWorkspaceResources(runner, options, "work-1", {
      memory: "3g",
      pidsLimit: "1024"
    });
    expect(updated).toMatchObject({ cpuCount: "2", memory: "3g", pidsLimit: "1024" });
    expect(await state.readWorkspace("work-1")).toMatchObject({
      cpuCount: "2",
      memory: "3g",
      pidsLimit: "1024"
    });
    expect(calls.at(-1)).toEqual([
      "docker", "update",
      "--cpus", "2",
      "--memory", "3g",
      "--memory-swap", "3g",
      "--pids-limit", "1024",
      "dim-ws-work-1"
    ]);

    await alignWorkspaceRoot(runner, options, "work-1");
    expect(calls.some((call) => call.slice(-3).join(" ") === "git switch main")).toBe(true);
    expect(calls.some((call) => call.slice(-4).join(" ") === "git merge --ff-only FETCH_HEAD")).toBe(true);

    calls.length = 0;
    projectStatus = " M .dim/setup.bash\n?? setup-output\n";
    await expect(alignWorkspaceRoot(runner, options, "work-1")).rejects.toThrow(/uncommitted project changes/);
    expect(calls.some((call) => call.includes("fetch"))).toBe(false);

    calls.length = 0;
    await alignWorkspaceRoot(runner, options, "work-1", true);
    expect(calls.some((call) =>
      call.slice(-6).join(" ") === "git switch --discard-changes --force-create main FETCH_HEAD"
    )).toBe(true);
    expect(calls.some((call) => call.slice(-3).join(" ") === "git clean -fd")).toBe(true);
    expect(calls.some((call) => call.includes("merge"))).toBe(false);
  });

  it("selects persistent workspace runtime backends", () => {
    const options = lifecycleOptions({ DIM_STATE_ROOT: root, DIM_CONFIG_PATH: join(root, "dim.json") });
    expect(workspaceRuntimePlan("sysbox", options)).toMatchObject({
      dockerRuntime: "runc",
      image: "dev-infra-project-workspace:latest",
      privileged: true,
      engine: "docker",
      env: { DIM_DOCKERD_FLAGS: "--feature containerd-snapshotter=false" }
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
      engine: "docker",
      env: { DIM_DOCKERD_FLAGS: "--feature containerd-snapshotter=false" }
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
