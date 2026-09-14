import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptions } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState, validateLifecycleName } from "../../../../core/packages/core/src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import {
  alignWorkspaceRoot,
  detectWorkspaceKvm,
  projectRuntimeManifest,
  resolveWorkspaceCapabilities,
  resolveRepositorySnapshot,
  resolveWorkspaceKvm,
  restartWorkspace,
  updateWorkspaceResources,
  validateRepositoryRefOverrides,
  validateWorkspaceProfiles,
  validateWorkspaceResources,
  waitForInnerDocker,
  workspaceContainerArgs
} from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { workspaceRuntimePlan } from "../../../../core/packages/core/src/runtimeBackends.js";
import { rootRepositorySnapshot } from "./lifecycleFixture.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";

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

it("checks dirty and divergent restarts under Project and setup locks before changing state", async () => {
    const state = new LifecycleState(root);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    let projectLocked = false;
    let setupLocked = false;
    vi.spyOn(LifecycleState.prototype, "acquireProjectLock").mockImplementation(async () => {
      projectLocked = true;
      return async () => {
        projectLocked = false;
      };
    });
    vi.spyOn(LifecycleState.prototype, "acquireWorkspaceSetupLock").mockImplementation(async () => {
      expect(projectLocked).toBe(true);
      setupLocked = true;
      return async () => {
        setupLocked = false;
      };
    });
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      schemaVersion: 4,
      id: "project-id",
      name: "project",
      gitNamespace: "dim-project",
      giteaOrganizationId: 41,
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
      schemaVersion: 5,
      name: "work-1",
      projectId: project.id,
      projectName: project.name,
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      rootCommit: "a".repeat(40),
      rootSnapshotPath: join(root, "assets", "project-roots", project.id, "a".repeat(40)),
      repositoryRefOverrides: {},
      repositorySnapshot: rootRepositorySnapshot("a".repeat(40)),
      projectPath: "/workspace/project",
      phase: "ready",
      profiles: ["development"],
      composeProjectName: "dim-work-1",
      containerName: "dim-ws-work-1",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-1-docker",
      runtimeBackend: "sysbox",
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
    await mkdir(workspace.rootSnapshotPath, { recursive: true });
    await state.claimWorkspace(workspace);
    const calls: string[][] = [];
    let checkout: "dirty" | "divergent" = "dirty";
    let stopCalls = 0;
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        if (args[0] === "network" && args[1] === "inspect") {
          return { command, args, stdout: "true\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "volume" && args[1] === "inspect") {
          return { command, args, stdout: "true\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "container" && args[1] === "inspect" && args[2] === "dim-gitea") {
          return { command, args, stdout: "gitea-container-id|true|true\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "exec" && args[1] === "gitea-container-id"
          && args.some((argument) => argument.includes("/data/dim/credentials.json"))) {
          return {
            command,
            args,
            stdout: JSON.stringify({
              adminUsername: "admin",
              adminPassword: "admin-secret",
              writerUsername: "writer",
              writerPassword: "writer-secret",
              maintainerUsername: "maintainer",
              maintainerPassword: "maintainer-secret"
            }),
            stderr: "",
            exitCode: 0
          };
        }
        if (args[0] === "exec" && args.includes("sh") && args.includes("-c")) {
          return { command, args, stdout: "true\n", stderr: "", exitCode: 0 };
        }
        if (args.includes("gitea") && args.includes("admin")) {
          return { command, args, stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "container" && args[1] === "inspect" && args[2] === workspace.containerName) {
          expect(projectLocked).toBe(true);
          expect(setupLocked).toBe(true);
          return { command, args, stdout: `${workspaceContainerInspect(workspace)}\n`, stderr: "", exitCode: 0 };
        }
        if (args.includes("--porcelain")) {
          expect(projectLocked).toBe(true);
          expect(setupLocked).toBe(true);
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
});
