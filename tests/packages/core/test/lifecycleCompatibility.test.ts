import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

it.each([5, 6] as const)("rejects schema %i workspace records without modifying them", async (schemaVersion) => {
    const state = new LifecycleState(root);
    const now = new Date().toISOString();
    await mkdir(join(root, "workspaces"), { recursive: true });
    const path = join(root, "workspaces", "legacy.json");
    const original = `${JSON.stringify({
      schemaVersion,
      name: "legacy",
      projectPath: "/workspace/project",
      repositorySnapshot: { root: { commit: "a".repeat(40) } },
      phase: "ready",
      containerName: "dim-ws-legacy",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-legacy-docker",
      routes: [],
      createdAt: now,
      updatedAt: now
    }, null, 2)}\n`;
    await writeFile(path, original);

    await expect(state.readWorkspace("legacy")).rejects.toThrow(/export.*recreate/i);
    await expect(readFile(path, "utf8")).resolves.toBe(original);
  });

it("rejects schema 7 workspace state without modifying it", async () => {
    const state = new LifecycleState(root);
    await mkdir(join(root, "workspaces"), { recursive: true });
    const target = join(root, "workspaces", "obsolete.json");
    const original = JSON.stringify({
      schemaVersion: 7,
      name: "obsolete",
      runtimeBackend: "sysbox",
      rootCommit: "a".repeat(40),
    });
    await writeFile(target, original);

    await expect(state.readWorkspace("obsolete")).rejects.toThrow(/schema 7.*expected 8.*export.*recreate/i);
    await expect(state.listWorkspaces()).rejects.toThrow(/schema 7.*expected 8.*export.*recreate/i);
    await expect(readFile(target, "utf8")).resolves.toBe(original);
  });
});
