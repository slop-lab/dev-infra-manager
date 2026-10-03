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
    const context = {
      workspaceId: "A".repeat(43), projectId: project.id, projectName: project.name,
      workspaceName: "work-1", runtimeBackend: "sysbox" as const
    };
    await expect(resolveWorkspaceCapabilities(
      { required: ["missing"], recommended: [] }, context, new Map()
    )).rejects.toThrow(/required workspace capability 'missing'/);
    await expect(resolveWorkspaceCapabilities(
      { required: [], recommended: ["missing"] }, context, new Map()
    )).resolves.toEqual([{
      name: "missing", requirement: "recommended", status: "unavailable", detail: "no installed provider"
    }]);
  });

  it("binds workspace capability provisioning to the workspace instance ID", async () => {
    // Given
    const provision = vi.fn(async () => ({}));
    const context = {
      workspaceId: "A".repeat(43),
      projectId: "project-id",
      projectName: "project",
      workspaceName: "work-1",
      runtimeBackend: "sysbox" as const
    };

    // When
    await resolveWorkspaceCapabilities(
      { required: ["device"], recommended: [] },
      context,
      new Map([["device", { plugin: "test", provider: { provision } }]])
    );

    // Then
    expect(provision).toHaveBeenCalledWith(context);
  });

  it("denies workspace capability overrides of host mirror routing", async () => {
    // Given
    const context = {
      workspaceId: "A".repeat(43),
      projectId: "project-id",
      projectName: "project",
      workspaceName: "work-1",
      runtimeBackend: "sysbox" as const
    };

    // When
    const resolution = resolveWorkspaceCapabilities(
      { required: ["mirror-override"], recommended: [] },
      context,
      new Map([["mirror-override", {
        plugin: "test",
        provider: { provision: async () => ({ environment: { DIM_APT_CACHE_ENDPOINT: "attacker:3142" } }) }
      }]])
    );

    // Then
    await expect(resolution).rejects.toThrow(/reserved host mirror environment/);
  });

  it("creates and authenticates a workspace-scoped external URL grant", async () => {
    const state = new LifecycleState(root);
    const now = new Date().toISOString();
    const record: WorkspaceRecord = {
    schemaVersion: 8,
      workspaceId: "A".repeat(43),
      name: "work-1",
      projectId: "project-id",
      projectName: "project",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      rootCommit: "a".repeat(40),
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
    expect(grant).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]+$/);
    expect(await state.ensureWorkspaceGrant(record.name)).toBe(grant);
    expect(await state.authenticateWorkspaceGrant(grant)).toEqual(record);
    expect(await state.authenticateWorkspaceGrant(`${grant}x`)).toBeUndefined();
    const agentGrant = await state.ensureAgentGrant(record.name);
    expect(agentGrant).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]+$/);
    expect(await state.authenticateAgentGrant(agentGrant)).toEqual(record);
    expect(await state.authenticateWorkspaceGrant(agentGrant)).toBeUndefined();
    expect(await state.authenticateAgentGrant(grant)).toBeUndefined();
    await state.removeWorkspaceGrant(record);
    await state.removeAgentGrant(record);
    expect(await state.authenticateWorkspaceGrant(grant)).toBeUndefined();
    expect(await state.authenticateAgentGrant(agentGrant)).toBeUndefined();
  });

  it("denies captured grants after interrupted discard and same-name recreation", async () => {
    // Given
    const state = new LifecycleState(root);
    const now = new Date().toISOString();
    const record: WorkspaceRecord = {
      schemaVersion: 8,
      workspaceId: "A".repeat(43),
      name: "work-1",
      projectId: "project-id",
      projectName: "project",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      rootCommit: "a".repeat(40),
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
      hostAliases: {},
      projectManifestPath: "/run/dim/project.json",
      createdAt: now,
      updatedAt: now
    };
    await state.claimWorkspace(record);
    const capturedWorkspaceGrant = await state.ensureWorkspaceGrant(record.name);
    const capturedAgentGrant = await state.ensureAgentGrant(record.name);

    // When
    await state.removeWorkspace(record.name);
    await state.claimWorkspace({
      ...record,
      workspaceId: "B".repeat(43),
      createdAt: new Date(Date.now() + 1).toISOString()
    });

    // Then
    expect(await state.authenticateWorkspaceGrant(capturedWorkspaceGrant)).toBeUndefined();
    expect(await state.authenticateAgentGrant(capturedAgentGrant)).toBeUndefined();
    const freshWorkspaceGrant = await state.ensureWorkspaceGrant(record.name);
    const freshAgentGrant = await state.ensureAgentGrant(record.name);
    expect(freshWorkspaceGrant).not.toBe(capturedWorkspaceGrant);
    expect(freshAgentGrant).not.toBe(capturedAgentGrant);
    await state.removeWorkspaceGrant(record);
    await state.removeAgentGrant(record);
    expect((await state.authenticateWorkspaceGrant(freshWorkspaceGrant))?.workspaceId).toBe("B".repeat(43));
    expect((await state.authenticateAgentGrant(freshAgentGrant))?.workspaceId).toBe("B".repeat(43));
  });
});
