import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptions } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState, validateLifecycleName } from "../../../../core/packages/core/src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import {
  detectWorkspaceKvm,
  projectRuntimeManifest,
  resolveWorkspaceCapabilities,
  resolveWorkspaceKvm,
  restartWorkspace,
  updateWorkspaceResources,
  validateWorkspaceProfiles,
  validateWorkspaceResources,
  waitForInnerDocker,
  workspaceContainerArgs
} from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { workspaceRuntimePlan } from "../../../../core/packages/core/src/runtimeBackends.js";
import { rootRepositorySnapshot } from "./lifecycleFixture.js";

describe("project and workspace lifecycle", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-lifecycle-"));
    await writeFile(join(root, "dim.json"), JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
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
      schemaVersion: 6,
      name: "work-1",
      projectId: "project-id",
      projectName: "project",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      rootCommit: "a".repeat(40),
      rootSnapshotPath: join(root, "assets", "project-roots", "project-id", "a".repeat(40)),
      workspaceDataPath: "/var/lib/dim/workspace-data",
      phase: "creating",
      profiles: [],
      capabilities: [{
        name: "writable-cgroup",
        requirement: "required",
        status: "provided",
        plugin: "capability-plugin",
        capabilities: ["SYS_ADMIN"],
        securityOptions: ["seccomp=unconfined"],
        devices: ["/dev/fuse"],
        environment: { DIM_WRITABLE_CGROUP: "1" }
      }],
      composeProjectName: "dim-work-1",
      containerName: "dim-ws-work-1",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-1-docker",
      runtimeBackend: "sysbox",
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
    }, "work-1.controller-grant", () => 992, "work-1.agent.agent-grant");
    expect(args).toEqual(expect.arrayContaining([
      "--name", "dim-ws-work-1",
      "--label", "dim.managed=true",
      "--label", "dim.project=project",
      "--label", "dim.repo=root",
      "--label", "dim.runtime-config=8",
      "--mount", `type=bind,source=${join(root, "assets", "project-roots", "project-id", "a".repeat(40))},target=/run/dim/project-root,readonly`,
      "--mount", "type=volume,source=dim-ws-work-1-docker,target=/var/lib/dim/workspace-data",
      "--cpus", "1.5",
      "--memory", "3g",
      "--pids-limit", "1024",
      "--env", "DIM_GIT_USERNAME=writer",
      "--env", "DIM_GIT_TOKEN=token",
      "--add-host", "host.docker.internal:host-gateway",
      "--add-host=registry-1.docker.io:127.0.0.1",
      "--add-host=auth.docker.io:127.0.0.1",
      "--add-host", "dim-gitea:172.20.0.2",
      "--mount", `type=bind,source=${join(options.controllerSocketPath, "..")},target=/run/dim/controller`,
      "--env", "DIM_CONTROLLER_SOCKET=/run/dim/controller/controller.sock",
      "--env", "DIM_CONTROLLER_TOKEN=work-1.controller-grant",
      "--mount", `type=bind,source=${join(options.agentControllerSocketPath, "..")},target=/run/dim/agent-controller`,
      "--env", "DIM_AGENT_CONTROLLER_SOCKET=/run/dim/agent-controller/controller.sock",
      "--env", "DIM_AGENT_CONTROLLER_TOKEN=work-1.agent.agent-grant",
      "--env", "DIM_REGISTRY_CACHE_ENDPOINT=dim-registry-cache:5000",
      "--env", "GIT_CONFIG_VALUE_0=Agent",
      "--cap-add", "SYS_ADMIN",
      "--security-opt", "seccomp=unconfined",
      "--device", "/dev/fuse",
      "--env", "DIM_WRITABLE_CGROUP=1",
      "--device", "/dev/kvm",
      "--group-add", "992",
      "--privileged"
    ]));
    expect(args).not.toContain("--rm");
    expect(args.join(" ")).not.toMatch(/dim-registry-cache:\d{1,3}(?:\.\d{1,3}){3}/);
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.join(" ")).not.toContain(join(options.adminControllerSocketPath, ".."));

    const withoutKvm = workspaceContainerArgs(options, { ...record, kvm: false }, {
      username: "writer",
      token: "token",
      userName: "Agent",
      userEmail: "agent@example.invalid"
    }, "work-1.controller-grant", () => 992, "work-1.agent.agent-grant");
    expect(withoutKvm).not.toContain("/dev/kvm");
    expect(withoutKvm).not.toContain("--group-add");
  });
});
