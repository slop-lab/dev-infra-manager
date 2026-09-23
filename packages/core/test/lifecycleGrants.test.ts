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

it("fails closed for required plugin capabilities and reports missing recommendations", async () => {
    const project = {
    schemaVersion: 4, id: "project-id", name: "project", gitNamespace: "dim-project", giteaOrganizationId: 41,
      phase: "ready", rootRepositoryAlias: "root", rootRef: "refs/heads/main",
      repositories: [], createdAt: "now", updatedAt: "now"
    } satisfies ProjectRecord;
    await expect(resolveWorkspaceCapabilities(
      ["missing"], [], project, "work-1", "sysbox", new Map()
    )).rejects.toThrow(/required workspace capability 'missing'/);
    await expect(resolveWorkspaceCapabilities(
      [], ["missing"], project, "work-1", "sysbox", new Map()
    )).resolves.toEqual([{
      name: "missing", requirement: "recommended", status: "unavailable", detail: "no installed provider"
    }]);
  });

it("creates and authenticates a workspace-scoped external URL grant", async () => {
    const state = new LifecycleState(root);
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
      phase: "ready",
      profiles: [],
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
      createdAt: now,
      updatedAt: now
    };
    await state.claimWorkspace(record);
    const grant = await state.ensureWorkspaceGrant(record.name);
    expect(grant).toMatch(/^work-1\./);
    expect(await state.ensureWorkspaceGrant(record.name)).toBe(grant);
    expect(await state.authenticateWorkspaceGrant(grant)).toEqual(record);
    expect(await state.authenticateWorkspaceGrant(`${grant}x`)).toBeUndefined();
    const agentGrant = await state.ensureAgentGrant(record.name);
    expect(agentGrant).toMatch(/^work-1\./);
    expect(await state.authenticateAgentGrant(agentGrant)).toEqual(record);
    expect(await state.authenticateWorkspaceGrant(agentGrant)).toBeUndefined();
    expect(await state.authenticateAgentGrant(grant)).toBeUndefined();
    await state.removeWorkspaceGrant(record.name);
    await state.removeAgentGrant(record.name);
    expect(await state.authenticateWorkspaceGrant(grant)).toBeUndefined();
    expect(await state.authenticateAgentGrant(agentGrant)).toBeUndefined();
  });
});
