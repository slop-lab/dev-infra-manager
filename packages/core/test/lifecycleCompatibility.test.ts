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

it("rejects schema 4 workspace records without modifying them", async () => {
    const state = new LifecycleState(root);
    const now = new Date().toISOString();
    await mkdir(join(root, "workspaces"), { recursive: true });
    await writeFile(join(root, "workspaces", "legacy.json"), JSON.stringify({
      schemaVersion: 4,
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

it("rejects workspace state from removed backends", async () => {
    const state = new LifecycleState(root);
    await mkdir(join(root, "workspaces"), { recursive: true });
    await writeFile(join(root, "workspaces", "obsolete.json"), JSON.stringify({
      schemaVersion: 5,
      name: "obsolete",
      runtimeBackend: "runc",
      rootCommit: "a".repeat(40),
      rootSnapshotPath: "/missing"
    }));

    await expect(state.readWorkspace("obsolete")).rejects.toThrow(/supports only sysbox/);
    await expect(state.listWorkspaces()).rejects.toThrow(/supports only sysbox/);
  });
});
