import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCiRunner } from "../../../../core/packages/core/src/ciRunner.js";
import { UserError } from "../../../../core/packages/core/src/errors.js";
import { ensureGitea } from "../../../../core/packages/core/src/gitea.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { LifecycleOptions, ProjectRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { createProject, planProjectRepositorySet } from "../../../../core/packages/core/src/projectRegistry.js";
import { parseRepositorySetYaml } from "../../../../core/packages/core/src/repositorySet.js";
import type { StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { createWorkspace } from "../../../../core/packages/core/src/workspaceCreation.js";
import { setupWorkspace } from "../../../../core/packages/core/src/workspaceSetup.js";
import {
  restartWorkspace,
  startWorkspace,
  updateWorkspace
} from "../../../../core/packages/core/src/workspaceTransitions.js";
import { hostLifecycleOptions } from "./hostLifecycleFixture.js";

const dependencyState = vi.hoisted(() => ({
  dispatchFailure: new Error("runtime work dispatched"),
  snapshotCalls: 0
}));

vi.mock("../../../../core/packages/core/src/gitea.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/gitea.js")>(),
  ensureGitea: vi.fn(async () => {
    throw dependencyState.dispatchFailure;
  })
}));

vi.mock("../../../../core/packages/core/src/protectedRootSnapshot.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/protectedRootSnapshot.js")>(),
  resolveProtectedRootSnapshot: vi.fn(async () => {
    dependencyState.snapshotCalls += 1;
    return SNAPSHOT;
  }),
  resolveProtectedRootSnapshotLocked: vi.fn(async () => {
    dependencyState.snapshotCalls += 1;
    throw dependencyState.dispatchFailure;
  })
}));

const PROJECT = {
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
    hostUrl: "http://host/root.git",
    workspaceUrl: "http://workspace/root.git",
    phase: "ready",
    connections: [],
    protectedPatterns: ["main"],
    protectionPhase: "applied",
    createdAt: "now",
    updatedAt: "now"
  }],
  createdAt: "now",
  updatedAt: "now"
} satisfies ProjectRecord;

const SNAPSHOT = {
  project: PROJECT,
  repository: PROJECT.repositories[0],
  rootRequestedRef: "refs/heads/main",
  rootRef: "refs/heads/main",
  rootCommit: "a".repeat(40),
  rootSnapshotPath: "/state/snapshots/project"
};

const OPTIONS = hostLifecycleOptions("/state");
const READ_FAILURE = new UserError("lifecycle record malformed: not found in expected structure");
const RUNNER = {
  async run(command: string, args: string[]) {
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  },
  async runStreaming() {
    return 0;
  }
} satisfies StreamingCommandRunner;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  dependencyState.snapshotCalls = 0;
});

describe("lifecycle record absence callers", () => {
  it("does not create a Project for a non-missing read error containing not found", async () => {
    // Given
    vi.spyOn(LifecycleState.prototype, "readProject").mockRejectedValue(READ_FAILURE);
    const claim = vi.spyOn(LifecycleState.prototype, "claimProject").mockResolvedValue();
    vi.spyOn(LifecycleState.prototype, "acquireProjectLock").mockResolvedValue(async () => {});

    // When
    const creation = createProject(RUNNER, OPTIONS, "project");

    // Then
    await expect(creation).rejects.toBe(READ_FAILURE);
    expect(claim).not.toHaveBeenCalled();
    expect(ensureGitea).not.toHaveBeenCalled();
  });

  it("does not plan repository creation for a non-missing read error containing not found", async () => {
    // Given
    vi.spyOn(LifecycleState.prototype, "readProject").mockRejectedValue(READ_FAILURE);
    const set = parseRepositorySetYaml("schemaVersion: 1\nrepositories:\n  root: {url: one, root: true}\n");

    // When
    const planning = planProjectRepositorySet(OPTIONS, "project", set, true);

    // Then
    await expect(planning).rejects.toBe(READ_FAILURE);
  });

  it("does not dispatch workspace runtime work for a non-missing read error containing not found", async () => {
    // Given
    vi.spyOn(LifecycleState.prototype, "readProject").mockResolvedValue(PROJECT);
    vi.spyOn(LifecycleState.prototype, "readWorkspace").mockRejectedValue(READ_FAILURE);
    vi.spyOn(LifecycleState.prototype, "acquireProjectLock").mockResolvedValue(async () => {});
    const claim = vi.spyOn(LifecycleState.prototype, "claimWorkspace").mockResolvedValue();

    // When
    const creation = createWorkspace(RUNNER, OPTIONS, {
      project: "project",
      name: "workspace",
      profiles: [],
      runtimeBackend: "sysbox"
    });

    // Then
    await expect(creation).rejects.toMatchObject({
      message: `workspace create at workspace state loading: ${READ_FAILURE.message}`,
      cause: READ_FAILURE
    });
    expect(claim).not.toHaveBeenCalled();
    expect(ensureGitea).not.toHaveBeenCalled();
  });

  it("attributes setup workspace-record failures without dispatching runtime work", async () => {
    // Given
    vi.spyOn(LifecycleState.prototype, "readWorkspace").mockRejectedValue(READ_FAILURE);

    // When
    const lifecycle = setupWorkspace(RUNNER, OPTIONS, "workspace");

    // Then
    await expect(lifecycle).rejects.toMatchObject({
      message: `workspace setup at workspace state loading: ${READ_FAILURE.message}`,
      cause: READ_FAILURE
    });
    expect(dependencyState.snapshotCalls).toBe(0);
    expect(ensureGitea).not.toHaveBeenCalled();
  });

  it.each([
    { operation: "update", invoke: () => updateWorkspace(RUNNER, OPTIONS, "workspace") },
    { operation: "start", invoke: () => startWorkspace(RUNNER, OPTIONS, "workspace") },
    { operation: "restart", invoke: () => restartWorkspace(RUNNER, OPTIONS, "workspace") }
  ])("attributes $operation workspace-record failures without dispatching runtime work", async ({ operation, invoke }) => {
    // Given
    vi.spyOn(LifecycleState.prototype, "readWorkspace").mockRejectedValue(READ_FAILURE);

    // When
    const lifecycle = invoke();

    // Then
    await expect(lifecycle).rejects.toMatchObject({
      message: `workspace ${operation} at workspace state loading: ${READ_FAILURE.message}`,
      cause: READ_FAILURE
    });
    expect(dependencyState.snapshotCalls).toBe(0);
    expect(ensureGitea).not.toHaveBeenCalled();
  });

  it("does not dispatch CI runtime work for a non-missing read error containing not found", async () => {
    // Given
    vi.spyOn(LifecycleState.prototype, "readProject").mockResolvedValue(PROJECT);
    vi.spyOn(LifecycleState.prototype, "readCiRunner").mockRejectedValue(READ_FAILURE);
    vi.spyOn(LifecycleState.prototype, "acquireProjectLock").mockResolvedValue(async () => {});
    vi.spyOn(LifecycleState.prototype, "acquireCiRunnerLock").mockResolvedValue(async () => {});

    // When
    const creation = createCiRunner(RUNNER, OPTIONS, {
      project: "project",
      name: "runner",
      executor: "sysbox"
    });

    // Then
    await expect(creation).rejects.toBe(READ_FAILURE);
    expect(dependencyState.snapshotCalls).toBe(0);
  });
});
