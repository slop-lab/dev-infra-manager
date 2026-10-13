import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { restartWorkspace, updateWorkspace } from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { workspaceRootSnapshotPath } from "../../../../core/packages/core/src/workspaceLifecycleTypes.js";
import { claimTestGiteaService } from "./giteaServiceFixture.js";
import { COMMIT, LifecycleRunner, projectFixture } from "./workspaceLifecycleSnapshotFixture.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace environment transition preflight", () => {
  it("rejects a managed restart mode change before stopping the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-transition-preflight-"));
    roots.push(root);
    const state = new LifecycleState(root);
    const project = projectFixture();
    const record = managedRecord();
    const snapshot = workspaceRootSnapshotPath(root, record);
    await mkdir(`${snapshot}/.dim`, { recursive: true });
    await writeFile(`${snapshot}/.dim/environment.yml`, "schemaVersion: 1\nenvironment: minimal\n");
    await state.claimProject(project);
    await claimTestGiteaService(root, 3300);
    await state.claimWorkspace(record);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    const runner = new ManagedTransitionRunner();
    runner.containerInspect = workspaceContainerInspect(record, { rootSnapshotPath: snapshot });

    await expect(restartWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), record.name))
      .rejects.toThrow(/environment changed/);
    expect(runner.runCalls.some((call) => call[1] === "stop")).toBe(false);
    await expect(state.readWorkspace(record.name)).resolves.toMatchObject({ phase: "ready" });
  });

  it("rejects a managed update mode change before inspecting or fencing the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-transition-preflight-"));
    roots.push(root);
    const state = new LifecycleState(root);
    const project = projectFixture();
    const record = managedRecord();
    const snapshot = workspaceRootSnapshotPath(root, record);
    await mkdir(`${snapshot}/.dim`, { recursive: true });
    await writeFile(`${snapshot}/.dim/environment.yml`, "schemaVersion: 1\nenvironment: minimal\n");
    await state.claimProject(project);
    await claimTestGiteaService(root, 3300);
    await state.claimWorkspace(record);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    const runner = new ManagedTransitionRunner();

    await expect(updateWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), record.name))
      .rejects.toThrow(/environment changed/);
    expect(runner.runCalls.some((call) => call[1] === "container" && call[2] === "inspect"
      && call[3] === record.containerName)).toBe(false);
    expect(runner.runCalls.some((call) => call.at(-2) === "phase" && call.at(-1) === "setting-up")).toBe(false);
    await expect(state.readWorkspace(record.name)).resolves.toMatchObject({ phase: "ready" });
  });

});

class ManagedTransitionRunner extends LifecycleRunner {
  override async run(command: string, args: string[]) {
    if (command === "git" && args.includes("ls-remote")) {
      return { command, args, stdout: `${COMMIT}\trefs/heads/main\n`, stderr: "", exitCode: 0 };
    }
    return super.run(command, args);
  }
}

function managedRecord(): WorkspaceRecord {
  return { schemaVersion: 8, workspaceId: "A".repeat(43), name: "work-1", projectId: "project-id",
    projectName: "project", rootRepositoryAlias: "root", rootRef: "refs/heads/main", rootCommit: COMMIT,
    workspaceDataPath: "/var/lib/dim/workspace-data", environment: "custom", phase: "ready", profiles: [],
    composeProjectName: "dim-work-1", containerName: "dim-ws-work-1", networkName: "dim-control",
    dockerVolumeName: "dim-ws-work-1-docker", runtimeBackend: "sysbox", kvm: false, cpuCount: "2",
    memory: "4g", pidsLimit: "2048", routes: [], gitUserName: "Agent", gitUserEmail: "agent@example.invalid",
    gitBaseUrl: "http://dim-gitea:3000/dim-project", hostAliases: {}, projectManifestPath: "/run/dim/project.json",
    createdAt: "now", updatedAt: "now" };
}
