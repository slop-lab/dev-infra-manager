import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptions } from "../../../../core/packages/managed/src/lifecycleOptions.js";
import { LifecycleState, validateLifecycleName } from "../../../../core/packages/managed/src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/managed/src/lifecycleTypes.js";
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
} from "../../../../core/packages/managed/src/workspaceLifecycle.js";
import { workspaceRuntimePlan } from "../../../../core/packages/managed/src/runtimeBackends.js";
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

it("publishes only the immutable root contract and generic runtime data", async () => {
    const now = new Date().toISOString();
    const workspace = {
      schemaVersion: 9 as const,
      workspaceId: "A".repeat(43),
      name: "work",
      projectId: "project-id",
      projectName: "project",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      rootCommit: "a".repeat(40),
      workspaceDataPath: "/var/lib/dim/workspace-data",
      phase: "ready" as const,
      profiles: [],
      composeProjectName: "dim-work",
      containerName: "dim-ws-work",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-docker",
      runtimeBackend: "sysbox" as const,
      kvm: false,
      cpuCount: "2",
      memory: "4g",
      pidsLimit: "2048",
      routes: [],
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
      hostAliases: {},
      projectManifestPath: "/run/dim/project.json",
      source: {
        kind: "native" as const,
        serviceId: "native-main" as const,
        snapshot: {
          projectId: "project-id",
          repositoryId: "root" as const,
          protectedRef: "refs/heads/main",
          commit: "a".repeat(40),
          tree: "b".repeat(40)
        },
        policyRevision: "c".repeat(64),
        requiredReviewRevision: "d".repeat(64),
        requiredJobSetRevision: "e".repeat(64)
      },
      createdAt: now,
      updatedAt: now
    };

    const manifest = projectRuntimeManifest(workspace, {
      version: 1,
      status: "unavailable",
      driver: "none",
      controllers: [],
      reason: "test"
    });

    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.root).toEqual({
      repository: "root",
      ref: "refs/heads/main",
      commit: "a".repeat(40),
      path: "/run/dim/project-root"
    });
    expect(manifest.data).toEqual({ path: "/var/lib/dim/workspace-data" });
    expect(manifest).not.toHaveProperty("repositories");
    expect(JSON.stringify(manifest)).not.toContain("token");
    expect(JSON.stringify(manifest)).not.toContain("password");

  });
});
