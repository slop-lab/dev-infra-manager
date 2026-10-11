import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import type { ProjectRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { giteaRequest } from "../../../../core/packages/core/src/gitea.js";
import {
  completeProjectRepositoryTransfer,
  importProjectRepository,
  prepareHostGitCredential,
  prepareProjectRepositoryTransfer
} from "../../../../core/packages/core/src/projectRegistry.js";
import { RecordingRunner } from "../../../../core/packages/core/src/runner.js";

vi.mock("../../../../core/packages/core/src/gitea.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/gitea.js")>(),
  ensureGitea: vi.fn(async () => ({
    adminUsername: "admin",
    adminPassword: "admin-secret",
    writerUsername: "writer",
    writerPassword: "writer-secret",
    maintainerUsername: "maintainer",
    maintainerPassword: "maintainer-secret",
    apiBaseUrl: "http://gitea.invalid/api/v1"
  })),
  giteaRequest: vi.fn(async () => new Response(null, { status: 204 }))
}));

describe("repository transfer completion", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("keeps an imported repository non-ready and non-writable when protection fails", async () => {
    const { state, options } = await importingProject(cleanup);
    const requests: string[] = [];
    vi.mocked(giteaRequest).mockImplementation(async (_connection, method, path) => {
      requests.push(`${method} ${path}`);
      return new Response(null, { status: path.includes("branch_protections") ? 500 : 204 });
    });

    await expect(completeProjectRepositoryTransfer(
      new RecordingRunner(), options, "example", "root", "transfer-1", { success: true }
    )).rejects.toThrow(/branch protection/);

    expect((await state.readProject("example")).repositories[0]).toMatchObject({
      phase: "error",
      protectionPhase: "pending"
    });
    expect(requests.filter((request) => request.startsWith("DELETE "))).toEqual([
      "DELETE /repos/dim-example/root/collaborators/writer",
      "DELETE /repos/dim-example/root/collaborators/maintainer"
    ]);
    expect(requests.some((request) => request.startsWith("PUT "))).toBe(false);
  });

  it("does not expose writer authority to a concurrent grant path before protection completes", async () => {
    const { state, options } = await importingProject(cleanup);
    const requests: string[] = [];
    let signalProtectionEntered: () => void = () => undefined;
    const protectionEntered = new Promise<void>((resolve) => { signalProtectionEntered = resolve; });
    let releaseProtection: () => void = () => undefined;
    const protectionRelease = new Promise<void>((resolve) => { releaseProtection = resolve; });
    let blockedProtection = false;
    vi.mocked(giteaRequest).mockImplementation(async (_connection, method, path) => {
      requests.push(`${method} ${path}`);
      if (path.includes("branch_protections") && !blockedProtection) {
        blockedProtection = true;
        signalProtectionEntered();
        await protectionRelease;
      }
      return new Response(null, { status: 204 });
    });

    const completion = completeProjectRepositoryTransfer(
      new RecordingRunner(), options, "example", "root", "transfer-1", { success: true }
    );
    await protectionEntered;
    await prepareHostGitCredential(new RecordingRunner(), options);

    expect(requests.some((request) => request.startsWith("PUT "))).toBe(false);
    expect((await state.readProject("example")).repositories[0]?.phase).toBe("importing");
    releaseProtection();
    await expect(completion).resolves.toMatchObject({ phase: "ready", protectionPhase: "applied" });
  });

  it("grants only trusted transfer authority while an import is unprotected", async () => {
    const { options } = await emptyProject(cleanup);
    const requests: string[] = [];
    vi.mocked(giteaRequest).mockImplementation(async (_connection, method, path) => {
      requests.push(`${method} ${path}`);
      return new Response(null, { status: 204 });
    });

    const prepared = await prepareProjectRepositoryTransfer(new RecordingRunner(), options, {
      project: "example",
      alias: "component",
      source: "https://example.invalid/component.git",
      root: false,
      protectedPatterns: ["main"]
    });

    expect(prepared).toMatchObject({
      writerUsername: "maintainer",
      writerPassword: "maintainer-secret",
      repository: { phase: "importing", protectionPhase: "pending" }
    });
    expect(requests.filter((request) => request.startsWith("PUT "))).toEqual([
      "PUT /repos/dim-example/component/collaborators/maintainer"
    ]);
  });

  it("fails a low-level import closed when its Git transfer fails", async () => {
    const { state, options } = await emptyProject(cleanup);
    const requests: string[] = [];
    vi.mocked(giteaRequest).mockImplementation(async (_connection, method, path) => {
      requests.push(`${method} ${path}`);
      return new Response(null, { status: 204 });
    });
    const runner = new RecordingRunner();
    vi.spyOn(runner, "run").mockResolvedValue({
      command: "git",
      args: [],
      stdout: "",
      stderr: "source unavailable",
      exitCode: 1
    });

    await expect(importProjectRepository(runner, options, {
      project: "example",
      alias: "component",
      source: "https://example.invalid/component.git",
      root: false,
      protectedPatterns: ["main"]
    })).rejects.toThrow(/source unavailable/);

    expect((await state.readProject("example")).repositories[0]?.phase).toBe("error");
    expect(requests.some((request) => request.includes("collaborators/writer") && request.startsWith("PUT ")))
      .toBe(false);
  });
});

async function importingProject(cleanup: string[]): Promise<{
  readonly state: LifecycleState;
  readonly options: ReturnType<typeof lifecycleOptionsForBackend>;
}> {
  const stateRoot = await mkdtemp(join(tmpdir(), "dim-transfer-completion-"));
  cleanup.push(stateRoot);
  const state = new LifecycleState(stateRoot);
  const project = {
    schemaVersion: 4,
    id: "project-id",
    name: "example",
    gitNamespace: "dim-example",
    giteaOrganizationId: 41,
    phase: "ready",
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    repositories: [{
      alias: "root",
      providerRepoId: "dim-example/root",
      owner: "dim-example",
      hostUrl: "http://host/dim-example/root.git",
      workspaceUrl: "http://gitea/dim-example/root.git",
      phase: "importing",
      connections: [],
      transferId: "transfer-1",
      protectedPatterns: ["main"],
      protectionPhase: "pending",
      createdAt: "now",
      updatedAt: "now"
    }],
    createdAt: "now",
    updatedAt: "now"
  } satisfies ProjectRecord;
  await state.claimProject(project);
  return {
    state,
    options: lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: stateRoot })
  };
}

async function emptyProject(cleanup: string[]): Promise<{
  readonly state: LifecycleState;
  readonly options: ReturnType<typeof lifecycleOptionsForBackend>;
}> {
  const stateRoot = await mkdtemp(join(tmpdir(), "dim-transfer-preparation-"));
  cleanup.push(stateRoot);
  const state = new LifecycleState(stateRoot);
  await state.claimProject({
    schemaVersion: 4,
    id: "project-id",
    name: "example",
    gitNamespace: "dim-example",
    giteaOrganizationId: 41,
    phase: "ready",
    repositories: [],
    createdAt: "now",
    updatedAt: "now"
  });
  return { state, options: lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: stateRoot }) };
}
