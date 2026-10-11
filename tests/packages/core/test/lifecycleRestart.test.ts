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
import { workspaceContainerInspect, workspaceVolumeInspect } from "./workspaceOwnershipFixture.js";

vi.mock("../../../../core/packages/core/src/registryCache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/registryCache.js")>(),
  ensureRegistryCache: vi.fn(async () => {})
}));

vi.mock("../../../../core/packages/core/src/gitea.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/gitea.js")>(),
  ensureGitea: vi.fn(async () => ({
    apiBaseUrl: "http://127.0.0.1:3300/api/v1",
    adminUsername: "admin",
    adminPassword: "admin-secret",
    writerUsername: "writer",
    writerPassword: "writer-secret",
    maintainerUsername: "maintainer",
    maintainerPassword: "maintainer-secret"
  })),
  giteaNestedBaseUrl: vi.fn(async () => "http://172.20.0.2:3000")
}));

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

it("restarts under Project and setup locks without inspecting or changing workspace Git", async () => {
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
    schemaVersion: 8,
    workspaceId: "A".repeat(43),
      name: "work-1",
      projectId: project.id,
      projectName: project.name,
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      rootCommit: "a".repeat(40),
      workspaceDataPath: "/var/lib/dim/workspace-data",
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
    const rootSnapshotPath = join(root, "assets", "project-roots", workspace.projectId, workspace.rootCommit);
    await mkdir(rootSnapshotPath, { recursive: true });
    await state.claimWorkspace(workspace);
    const calls: string[][] = [];
    let stopCalls = 0;
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        if (args[0] === "container" && args[1] === "inspect"
          && args.some((argument) => argument.includes("NetworkSettings.Networks"))) {
          return { command, args, stdout: "172.20.0.2\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "network" && args[1] === "inspect") {
          return { command, args, stdout: "true\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "volume" && args[1] === "inspect") {
          return { command, args, stdout: `${workspaceVolumeInspect(workspace)}\n`, stderr: "", exitCode: 0 };
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
          return { command, args, stdout: `${workspaceContainerInspect(workspace, { rootSnapshotPath })}\n`, stderr: "", exitCode: 0 };
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
        return { command, args, stdout: "", stderr: "", exitCode: 0 };
      },
      async runStreaming() {
        stopCalls += 1;
        return 0;
      }
    };
    const options = lifecycleOptions({ DIM_STATE_ROOT: root, DIM_CONFIG_PATH: join(root, "dim.json") });

    await expect(restartWorkspace(runner, options, workspace.name)).resolves.toMatchObject({ phase: "ready" });
    expect(stopCalls).toBeGreaterThan(0);
    expect(calls.some((call) => call[0] === "docker" && call.includes("git"))).toBe(false);
  });
});
