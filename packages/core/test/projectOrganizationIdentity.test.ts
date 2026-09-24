import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureGitea, giteaRequest } from "../../../../core/packages/core/src/gitea.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { createProject } from "../../../../core/packages/core/src/projectRegistry.js";
import { RecordingRunner } from "../../../../core/packages/core/src/runner.js";
import { hostLifecycleOptions } from "./hostLifecycleFixture.js";

vi.mock("../../../../core/packages/core/src/gitea.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/gitea.js")>(),
  ensureGitea: vi.fn(async () => ({
    kind: "managed" as const,
    adminUsername: "admin",
    adminPassword: "admin-secret",
    writerUsername: "writer",
    writerPassword: "writer-secret",
    maintainerUsername: "maintainer",
    maintainerPassword: "maintainer-secret",
    apiBaseUrl: "http://gitea.invalid/api/v1",
    hostBaseUrl: "http://gitea.invalid",
    workspaceBaseUrl: "http://dim-gitea:3000",
    runnerBaseUrl: "http://dim-gitea:3000"
  })),
  giteaRequest: vi.fn()
}));

type StoredProjectFixture = {
  readonly schemaVersion: number;
  readonly id: string;
  readonly name: string;
  readonly gitNamespace: string;
  readonly giteaOrganizationId: number | null;
  readonly phase: "creating" | "ready" | "error";
  readonly repositories: readonly [];
  readonly createdAt: string;
  readonly updatedAt: string;
};

function storedProject(giteaOrganizationId: number | null, phase: StoredProjectFixture["phase"]): StoredProjectFixture {
  return {
    schemaVersion: 4,
    id: "project-id",
    name: "example",
    gitNamespace: "dim-example",
    giteaOrganizationId,
    phase,
    repositories: [],
    createdAt: "now",
    updatedAt: "now"
  };
}

async function writeStoredProject(stateRoot: string, project: StoredProjectFixture): Promise<void> {
  const projects = join(stateRoot, "projects");
  await mkdir(projects, { recursive: true });
  await writeFile(join(projects, "example.json"), JSON.stringify(project));
}

function organizationResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("Project Gitea organization identity", () => {
  let stateRoot = "";

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "dim-project-organization-"));
    vi.mocked(ensureGitea).mockResolvedValue({
      kind: "managed",
      adminUsername: "admin",
      adminPassword: "admin-secret",
      writerUsername: "writer",
      writerPassword: "writer-secret",
      maintainerUsername: "maintainer",
      maintainerPassword: "maintainer-secret",
      apiBaseUrl: "http://gitea.invalid/api/v1",
      hostBaseUrl: "http://gitea.invalid",
      workspaceBaseUrl: "http://dim-gitea:3000",
      runnerBaseUrl: "http://dim-gitea:3000"
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("persists the POST response identity while the Project is still creating", async () => {
    // Given
    vi.mocked(giteaRequest).mockResolvedValue(organizationResponse({ id: 41, username: "dim-example" }, 201));
    const writes = vi.spyOn(LifecycleState.prototype, "writeProject");

    // When
    await createProject(new RecordingRunner(), hostLifecycleOptions(stateRoot), "example");

    // Then
    expect(writes.mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining({
        schemaVersion: 4,
        phase: "creating",
        gitNamespace: "dim-example",
        giteaOrganizationId: 41
      }),
      expect.objectContaining({
        schemaVersion: 4,
        phase: "ready",
        gitNamespace: "dim-example",
        giteaOrganizationId: 41
      })
    ]);
  });

  it("serializes concurrent creation before selecting absent Project state", async () => {
    // Given
    let releaseFirstPost: () => void = () => {};
    let markFirstPostReached: () => void = () => {};
    let markSecondLockAttempted: () => void = () => {};
    const firstPostRelease = new Promise<void>((resolve) => { releaseFirstPost = resolve; });
    const firstPostReached = new Promise<void>((resolve) => { markFirstPostReached = resolve; });
    const secondLockAttempted = new Promise<void>((resolve) => { markSecondLockAttempted = resolve; });
    let postCount = 0;
    vi.mocked(giteaRequest).mockImplementation(async () => {
      postCount += 1;
      if (postCount === 1) {
        markFirstPostReached();
        await firstPostRelease;
      }
      return organizationResponse({ id: postCount === 1 ? 41 : 42, username: "dim-example" }, 201);
    });
    const acquireProjectLock = LifecycleState.prototype.acquireProjectLock;
    let lockAttempts = 0;
    vi.spyOn(LifecycleState.prototype, "acquireProjectLock").mockImplementation(async function (
      this: LifecycleState,
      name
    ) {
      lockAttempts += 1;
      if (lockAttempts === 2) markSecondLockAttempted();
      return acquireProjectLock.call(this, name);
    });

    // When
    const firstCreation = createProject(new RecordingRunner(), hostLifecycleOptions(stateRoot), "example");
    await firstPostReached;
    const secondCreation = createProject(new RecordingRunner(), hostLifecycleOptions(stateRoot), "example");
    await secondLockAttempted;
    releaseFirstPost();

    // Then
    await expect(firstCreation).resolves.toMatchObject({ phase: "ready", giteaOrganizationId: 41 });
    await expect(secondCreation).rejects.toThrow("project 'example' already exists");
    expect(postCount).toBe(1);
    await expect(new LifecycleState(stateRoot).readProject("example")).resolves.toMatchObject({
      phase: "ready",
      giteaOrganizationId: 41
    });
  });

  it("retries a persisted identity by exact ID and username without POST creation", async () => {
    // Given
    await writeStoredProject(stateRoot, storedProject(41, "error"));
    const requests: string[] = [];
    vi.mocked(giteaRequest).mockImplementation(async (_connection, method, path) => {
      requests.push(`${method} ${path}`);
      return organizationResponse({ id: 41, username: "dim-example" });
    });

    // When
    const project = await createProject(new RecordingRunner(), hostLifecycleOptions(stateRoot), "example");

    // Then
    expect(project).toMatchObject({
      schemaVersion: 4,
      phase: "ready",
      gitNamespace: "dim-example",
      giteaOrganizationId: 41
    });
    expect(requests).toEqual(["GET /orgs/dim-example"]);
  });

  it("preserves a captured organization ID when a subsequent ready write fails", async () => {
    // Given
    vi.mocked(giteaRequest).mockResolvedValue(organizationResponse({ id: 41, username: "dim-example" }, 201));
    const writeProject = LifecycleState.prototype.writeProject;
    vi.spyOn(LifecycleState.prototype, "writeProject").mockImplementation(async function (
      this: LifecycleState,
      record
    ) {
      if (record.phase === "ready") throw new Error("ready persistence failed");
      await writeProject.call(this, record);
    });

    // When
    const creation = createProject(new RecordingRunner(), hostLifecycleOptions(stateRoot), "example");

    // Then
    await expect(creation).rejects.toThrow("ready persistence failed");
    await expect(new LifecycleState(stateRoot).readProject("example")).resolves.toMatchObject({
      phase: "error",
      giteaOrganizationId: 41
    });
  });

  it.each([
    ["a different numeric ID", { id: 42, username: "dim-example" }],
    ["a different username", { id: 41, username: "other" }],
    ["a malformed ID", { id: "41", username: "dim-example" }]
  ])("rejects %s for a persisted organization identity", async (_case, responseBody) => {
    // Given
    await writeStoredProject(stateRoot, storedProject(41, "error"));
    const requests: string[] = [];
    vi.mocked(giteaRequest).mockImplementation(async (_connection, method, path) => {
      requests.push(`${method} ${path}`);
      return organizationResponse(responseBody);
    });

    // When
    const retry = createProject(new RecordingRunner(), hostLifecycleOptions(stateRoot), "example");

    // Then
    await expect(retry).rejects.toThrow();
    expect(requests).toEqual(["GET /orgs/dim-example"]);
  });

  it("fails closed on POST 422 with a null persisted ID without GET adoption", async () => {
    // Given
    const requests: string[] = [];
    vi.mocked(giteaRequest).mockImplementation(async (_connection, method, path) => {
      requests.push(`${method} ${path}`);
      if (method === "POST") return new Response(null, { status: 422 });
      return organizationResponse({ id: 41, username: "dim-example" });
    });

    // When
    const creation = createProject(new RecordingRunner(), hostLifecycleOptions(stateRoot), "example");

    // Then
    await expect(creation).rejects.toThrow(/administrator reconciliation is required/);
    expect(requests).toEqual(["POST /orgs"]);
  });

  it("attaches an external host to an explicitly bound shared Project identity", async () => {
    // Given
    vi.mocked(ensureGitea).mockResolvedValue({
      kind: "external",
      adminUsername: "admin",
      adminPassword: "admin-secret",
      writerUsername: "writer",
      writerPassword: "writer-secret",
      maintainerUsername: "maintainer",
      maintainerPassword: "maintainer-secret",
      apiBaseUrl: "http://gitea.invalid/api/v1",
      hostBaseUrl: "http://gitea.invalid",
      workspaceBaseUrl: "http://gitea.invalid",
      runnerBaseUrl: "http://gitea.invalid",
      projectBindings: {
        example: { id: "shared-project-id", gitNamespace: "dim-example", giteaOrganizationId: 41 }
      }
    });
    const requests: string[] = [];
    vi.mocked(giteaRequest).mockImplementation(async (_connection, method, path) => {
      requests.push(`${method} ${path}`);
      return organizationResponse({ id: 41, username: "dim-example" });
    });

    // When
    const project = await createProject(new RecordingRunner(), {
      ...hostLifecycleOptions(stateRoot),
      giteaConnection: { kind: "external", file: "/run/secrets/gitea.json" }
    }, "example");

    // Then
    expect(project).toMatchObject({
      id: "shared-project-id",
      gitNamespace: "dim-example",
      giteaOrganizationId: 41,
      phase: "ready"
    });
    expect(requests).toEqual(["GET /orgs/dim-example"]);
  });

  it("rejects an unbound external Project before claiming local state", async () => {
    // Given
    vi.mocked(ensureGitea).mockResolvedValue({
      kind: "external",
      adminUsername: "admin",
      adminPassword: "admin-secret",
      writerUsername: "writer",
      writerPassword: "writer-secret",
      maintainerUsername: "maintainer",
      maintainerPassword: "maintainer-secret",
      apiBaseUrl: "http://gitea.invalid/api/v1",
      hostBaseUrl: "http://gitea.invalid",
      workspaceBaseUrl: "http://gitea.invalid",
      runnerBaseUrl: "http://gitea.invalid",
      projectBindings: {}
    });

    // When
    const creation = createProject(new RecordingRunner(), {
      ...hostLifecycleOptions(stateRoot),
      giteaConnection: { kind: "external", file: "/run/secrets/gitea.json" }
    }, "example");

    // Then
    await expect(creation).rejects.toThrow(/no explicit Project binding/);
    await expect(new LifecycleState(stateRoot).readProject("example")).rejects.toThrow();
    expect(giteaRequest).not.toHaveBeenCalled();
  });
});
