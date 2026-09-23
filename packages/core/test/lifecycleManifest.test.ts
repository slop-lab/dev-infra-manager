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

it("publishes only the immutable root contract and generic runtime data", async () => {
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
    schemaVersion: 4 as const,
      id: "project-id",
      name: "project",
    gitNamespace: "dim-project",
    giteaOrganizationId: 41,
      phase: "ready" as const,
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      repositories: [repository("source", "ready"), repository("root", "ready")],
      createdAt: now,
      updatedAt: now
    };
    const workspace = {
      schemaVersion: 6 as const,
      name: "work",
      projectId: project.id,
      projectName: project.name,
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      rootCommit: "a".repeat(40),
      rootSnapshotPath: "/state/assets/project-roots/project-id/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
      gitBaseUrl: "http://dim-gitea:3000/dim-project",
      hostAliases: {},
      projectManifestPath: "/run/dim/project.json",
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
