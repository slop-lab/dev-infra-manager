import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/managed/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/managed/src/lifecycleState.js";
import * as nativeWorkspaceSelection from "../../../../core/packages/managed/src/nativeWorkspaceSelection.js";
import type { WorkspaceRecord } from "../../../../core/packages/managed/src/lifecycleTypes.js";
import { restartWorkspace, startWorkspace, updateWorkspace } from "../../../../core/packages/managed/src/workspaceLifecycle.js";
import { workspaceRootSnapshotPath } from "../../../../core/packages/managed/src/workspaceLifecycleTypes.js";
import { COMMIT, LifecycleRunner } from "./workspaceLifecycleSnapshotFixture.js";
import { nativeWorkspaceFixture } from "./nativeLifecycleFixture.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";

const roots: string[] = [];

beforeEach(() => {
  vi.spyOn(nativeWorkspaceSelection, "selectCurrentNativeWorkspaceRoot")
    .mockImplementation(async (_options, record) => record);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace environment transition preflight", () => {
  it.each(["start", "restart"] as const)("rejects an obsolete selector before managed %s reconciles runtime", async (operation) => {
    const root = await mkdtemp(join(tmpdir(), "dim-transition-preflight-"));
    roots.push(root);
    const state = new LifecycleState(root);
    const record = managedRecord();
    delete record.environment;
    record.phase = "stopped";
    const snapshot = workspaceRootSnapshotPath(root, record);
    await mkdir(`${snapshot}/.dim`, { recursive: true });
    await writeFile(`${snapshot}/.dim/environment.yml`, "schemaVersion: 1\nenvironment: minimal\n");
    await state.claimWorkspace(record);
    const runner = new ManagedTransitionRunner();
    runner.containerInspect = workspaceContainerInspect(record, { rootSnapshotPath: snapshot, running: false });

    const invoke = operation === "start" ? startWorkspace : restartWorkspace;
    await expect(invoke(runner, options(root), record.name))
      .rejects.toThrow(/unsupported/i);
    expect(runner.runCalls.some((call) => call[1] === "container" && call[2] === "inspect"
      && call[3] === record.containerName)).toBe(false);
    await expect(state.readWorkspace(record.name)).resolves.toEqual(record);
  });

  it("rejects a managed restart mode change before stopping the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-transition-preflight-"));
    roots.push(root);
    const state = new LifecycleState(root);
    const record = managedRecord();
    const snapshot = workspaceRootSnapshotPath(root, record);
    await mkdir(`${snapshot}/.dim`, { recursive: true });
    await state.claimWorkspace(record);
    const runner = new ManagedTransitionRunner();
    runner.containerInspect = workspaceContainerInspect(record, { rootSnapshotPath: snapshot });

    await expect(restartWorkspace(runner, options(root), record.name))
      .rejects.toThrow(/environment changed/);
    expect(runner.runCalls.some((call) => call[1] === "stop")).toBe(false);
    await expect(state.readWorkspace(record.name)).resolves.toMatchObject({ phase: "ready" });
  });

  it("rejects a managed update mode change before inspecting or fencing the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-transition-preflight-"));
    roots.push(root);
    const state = new LifecycleState(root);
    const record = managedRecord();
    const snapshot = workspaceRootSnapshotPath(root, record);
    await mkdir(`${snapshot}/.dim`, { recursive: true });
    await state.claimWorkspace(record);
    const runner = new ManagedTransitionRunner();

    await expect(updateWorkspace(runner, options(root), record.name))
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
  return nativeWorkspaceFixture({ rootCommit: COMMIT, environment: "custom" });
}

function options(stateRoot: string) {
  return lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: stateRoot,
    DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: join(stateRoot, "control.json") });
}
