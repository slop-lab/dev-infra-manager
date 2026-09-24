import { beforeEach, describe, expect, it, vi } from "vitest";
import { giteaRequest } from "../../../../core/packages/core/src/gitea.js";
import { giteaCiCoordinator } from "../../../../core/packages/core/src/giteaCiCoordinator.js";
import type { LifecycleOptions, ProjectRecord, ProjectRepositoryRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { SYSBOX_CI_RUNNER_IMAGE } from "../../../../core/packages/core/src/sysboxCiRunnerAssets.js";
import type { CommandRunner } from "../../../../core/packages/core/src/types.js";

const seams = vi.hoisted(() => ({ requests: new Array<string>() }));

vi.mock("../../../../core/packages/core/src/gitea.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/gitea.js")>(),
  configureGiteaWebhookAllowedHosts: vi.fn(async () => {}),
  ensureGitea: vi.fn(async () => ({ adminUsername: "admin", adminPassword: "secret", apiBaseUrl: "http://gitea/api/v1" })),
  giteaRequest: vi.fn()
}));

vi.mock("../../../../core/packages/core/src/lifecycleState.js", () => ({
  LifecycleState: class {
    async listCiRunners(): Promise<readonly []> { return []; }
  }
}));

const runner = {
  async run(command: string, args: string[]) {
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  }
} satisfies CommandRunner;
const options = {
  stateRoot: "/state", giteaConnection: { kind: "managed" }, giteaImage: "gitea", giteaHost: "gitea", giteaPort: 3000,
  giteaAdminUsername: "admin", gitUsername: "writer", gitMaintainerUsername: "maintainer",
  defaultWorkspaceBackend: "sysbox", cpuCount: "4", memory: "8GiB", pidsLimit: "2048",
  controllerRuntimeDirectory: "/run/dim", controllerSocketPath: "/run/dim/controller.sock",
  agentControllerSocketPath: "/run/dim/agent.sock", adminControllerSocketPath: "/run/dim/admin.sock",
  ciRunnerImage: SYSBOX_CI_RUNNER_IMAGE, ciRunnerRuntime: "sysbox-runc",
  ciRunnerDefaultCpus: "4", ciRunnerDefaultMemory: "8GiB", ciRunnerDefaultPidsLimit: "2048"
} satisfies LifecycleOptions;
const repository = {
  alias: "root", providerRepoId: "dim-project/root", owner: "dim-project",
  hostUrl: "http://host/root.git", workspaceUrl: "http://workspace/root.git",
  phase: "ready", connections: [], protectedPatterns: ["main"], protectionPhase: "applied",
  createdAt: "now", updatedAt: "now"
} satisfies ProjectRepositoryRecord;
const project = {
  schemaVersion: 4, id: "project-id", name: "project", gitNamespace: "dim-project",
  giteaOrganizationId: 41, phase: "ready", rootRepositoryAlias: "root",
  rootRef: "refs/heads/main", repositories: [repository], createdAt: "now", updatedAt: "now"
} satisfies ProjectRecord;

describe("Gitea queued workflow-job reconciliation", () => {
  beforeEach(() => {
    seams.requests.length = 0;
    vi.mocked(giteaRequest).mockReset();
  });

  it("enumerates a clamped shrinking queue from last page to first before replay", async () => {
    // Given
    const replayed: Array<{ readonly id: number; readonly labels: readonly string[] }> = [];
    vi.mocked(giteaRequest).mockImplementation(async (_credentials, method, path) => {
      seams.requests.push(`${method} ${path}`);
      if (method === "GET" && path.endsWith("/hooks")) return Response.json([]);
      if (method === "POST" && path.endsWith("/hooks")) return new Response(null, { status: 201 });
      if (seams.requests.filter((request) => request.includes("/actions/jobs?")).length === 1) {
        return Response.json({ total_count: 205, jobs: queuedJobs(1, 50) }, {
          headers: { Link: '<https://code.example.test/api/v1/orgs/dim-project/actions/jobs?status=queued&page=5&limit=100>; rel="last"' }
        });
      }
      if (path.includes("page=5")) return Response.json({ total_count: 205, jobs: queuedJobs(201, 205) });
      if (path.includes("page=4")) return Response.json({ total_count: 155, jobs: queuedJobs(201, 205) });
      if (path.includes("page=3")) return Response.json({ total_count: 155, jobs: queuedJobs(151, 200) });
      if (path.includes("page=2")) return Response.json({ total_count: 155, jobs: queuedJobs(101, 150) });
      return Response.json({ total_count: 155, jobs: queuedJobs(51, 100) });
    });

    // When
    await giteaCiCoordinator.ensureWorkflowJobWebhook(runner, options, project, {
      url: "http://supervisor:8080/workflow-job",
      authorizationHeader: "Bearer replay",
      replayQueuedJob: async (job) => {
        expect(seams.requests.filter((request) => request.includes("/actions/jobs?"))).toHaveLength(6);
        replayed.push(job);
      }
    });

    // Then
    expect(seams.requests).toEqual([
      "GET /orgs/dim-project/hooks",
      "POST /orgs/dim-project/hooks",
      "GET /orgs/dim-project/actions/jobs?status=queued&page=1&limit=100",
      "GET /orgs/dim-project/actions/jobs?status=queued&page=5&limit=50",
      "GET /orgs/dim-project/actions/jobs?status=queued&page=4&limit=50",
      "GET /orgs/dim-project/actions/jobs?status=queued&page=3&limit=50",
      "GET /orgs/dim-project/actions/jobs?status=queued&page=2&limit=50",
      "GET /orgs/dim-project/actions/jobs?status=queued&page=1&limit=50"
    ]);
    expect(replayed.map((job) => job.id)).toEqual(Array.from({ length: 205 }, (_, index) => index + 1));
  });

  it("fails closed when duplicate pages cannot account for the final queued total", async () => {
    // Given
    const replayed: number[] = [];
    let queueRequests = 0;
    vi.mocked(giteaRequest).mockImplementation(async (_credentials, method, path) => {
      if (method === "GET" && path.endsWith("/hooks")) return Response.json([]);
      if (method === "POST" && path.endsWith("/hooks")) return new Response(null, { status: 201 });
      queueRequests += 1;
      if (queueRequests === 1) return Response.json({ total_count: 3, jobs: queuedJobs(41, 42) }, {
        headers: { Link: '<https://code.example.test/api/v1/orgs/dim-project/actions/jobs?status=queued&page=2&limit=100>; rel="last"' }
      });
      if (path.includes("page=2")) return Response.json({ total_count: 3, jobs: queuedJobs(42, 42) });
      return Response.json({ total_count: 3, jobs: queuedJobs(41, 42) });
    });

    // When / Then
    await expect(giteaCiCoordinator.ensureWorkflowJobWebhook(runner, options, project, {
      url: "http://supervisor:8080/workflow-job",
      authorizationHeader: "Bearer replay",
      replayQueuedJob: async (job) => { replayed.push(job.id); }
    })).rejects.toThrow(/inconsistent queued workflow job pagination/);
    expect(queueRequests).toBe(3);
    expect(replayed).toEqual([]);
  });

  it.each([
    "not a link",
    '<https://code.example.test/api/v1/orgs/dim-project/actions/jobs?status=queued&page=2&limit=50>; rel="last"'
  ])("rejects malformed or mismatched Link metadata without requesting it", async (link) => {
    // Given
    let queueRequests = 0;
    vi.mocked(giteaRequest).mockImplementation(async (_credentials, method, path) => {
      if (method === "GET" && path.endsWith("/hooks")) return Response.json([]);
      if (method === "POST" && path.endsWith("/hooks")) return new Response(null, { status: 201 });
      queueRequests += 1;
      return Response.json({ total_count: 101, jobs: queuedJobs(1, 100) }, {
        headers: { Link: link }
      });
    });

    // When / Then
    await expect(giteaCiCoordinator.ensureWorkflowJobWebhook(runner, options, project, {
      url: "http://supervisor:8080/workflow-job",
      authorizationHeader: "Bearer replay",
      replayQueuedJob: async () => {}
    })).rejects.toThrow(/invalid pagination metadata/);
    expect(queueRequests).toBe(1);
  });

  it("derives reverse pages from a clearly clamped first page without Link metadata", async () => {
    // Given
    const requestedPages: number[] = [];
    vi.mocked(giteaRequest).mockImplementation(async (_credentials, method, path) => {
      if (method === "GET" && path.endsWith("/hooks")) return Response.json([]);
      if (method === "POST" && path.endsWith("/hooks")) return new Response(null, { status: 201 });
      const page = Number(new URL(`http://gitea${path}`).searchParams.get("page"));
      requestedPages.push(page);
      if (requestedPages.length === 1) return Response.json({ total_count: 120, jobs: queuedJobs(1, 50) });
      if (page === 3) return Response.json({ total_count: 120, jobs: queuedJobs(101, 120) });
      if (page === 2) return Response.json({ total_count: 120, jobs: queuedJobs(51, 100) });
      return Response.json({ total_count: 120, jobs: queuedJobs(1, 50) });
    });

    // When
    await giteaCiCoordinator.ensureWorkflowJobWebhook(runner, options, project, {
      url: "http://supervisor:8080/workflow-job",
      authorizationHeader: "Bearer replay",
      replayQueuedJob: async () => {}
    });

    // Then
    expect(requestedPages).toEqual([1, 3, 2, 1]);
  });

  it.each([
    { totalCount: 0, jobs: queuedJobs(1, 0), replayed: [] },
    { totalCount: 1, jobs: queuedJobs(77, 77), replayed: [77] }
  ])("handles a $totalCount-job queue without Link metadata", async ({ totalCount, jobs, replayed }) => {
    // Given
    vi.mocked(giteaRequest).mockImplementation(async (_credentials, method, path) => {
      if (method === "GET" && path.endsWith("/hooks")) return Response.json([]);
      if (method === "POST" && path.endsWith("/hooks")) return new Response(null, { status: 201 });
      seams.requests.push(path);
      return Response.json({ total_count: totalCount, jobs });
    });
    const replayedIds: number[] = [];

    // When
    await giteaCiCoordinator.ensureWorkflowJobWebhook(runner, options, project, {
      url: "http://supervisor:8080/workflow-job",
      authorizationHeader: "Bearer replay",
      replayQueuedJob: async (job) => { replayedIds.push(job.id); }
    });

    // Then
    expect(seams.requests).toEqual(["/orgs/dim-project/actions/jobs?status=queued&page=1&limit=100"]);
    expect(replayedIds).toEqual(replayed);
  });

  it.each([
    { name: "missing body fields", body: {} },
    { name: "unsafe job ID", body: { total_count: 1, jobs: [{ id: Number.MAX_SAFE_INTEGER + 1, labels: ["dim-qemu"], status: "queued" }] } },
    { name: "non-string label", body: { total_count: 1, jobs: [{ id: 1, labels: [7], status: "queued" }] } },
    { name: "non-queued status", body: { total_count: 1, jobs: [{ id: 1, labels: ["dim-qemu"], status: "completed" }] } }
  ])("rejects $name from the coordinator boundary", async ({ body }) => {
    // Given
    vi.mocked(giteaRequest).mockImplementation(async (_credentials, method, path) => {
      if (method === "GET" && path.endsWith("/hooks")) return Response.json([]);
      if (method === "POST" && path.endsWith("/hooks")) return new Response(null, { status: 201 });
      return Response.json(body);
    });

    // When / Then
    await expect(giteaCiCoordinator.ensureWorkflowJobWebhook(runner, options, project, {
      url: "http://supervisor:8080/workflow-job",
      authorizationHeader: "Bearer replay",
      replayQueuedJob: async () => {}
    })).rejects.toThrow(/queued workflow jobs/);
  });

  it("fails capacity admission when the queued-jobs API fails", async () => {
    // Given
    vi.mocked(giteaRequest).mockImplementation(async (_credentials, method, path) => {
      if (method === "GET" && path.endsWith("/hooks")) return Response.json([]);
      if (method === "POST" && path.endsWith("/hooks")) return new Response(null, { status: 201 });
      return new Response(null, { status: 503 });
    });

    // When / Then
    await expect(giteaCiCoordinator.ensureWorkflowJobWebhook(runner, options, project, {
      url: "http://supervisor:8080/workflow-job",
      authorizationHeader: "Bearer replay",
      replayQueuedJob: async () => {}
    })).rejects.toThrow(/503/);
  });

  it("rejects malformed queued-jobs JSON", async () => {
    // Given
    vi.mocked(giteaRequest).mockImplementation(async (_credentials, method, path) => {
      if (method === "GET" && path.endsWith("/hooks")) return Response.json([]);
      if (method === "POST" && path.endsWith("/hooks")) return new Response(null, { status: 201 });
      return new Response("{", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    // When / Then
    await expect(giteaCiCoordinator.ensureWorkflowJobWebhook(runner, options, project, {
      url: "http://supervisor:8080/workflow-job",
      authorizationHeader: "Bearer replay",
      replayQueuedJob: async () => {}
    })).rejects.toThrow(/invalid JSON/);
  });

  it("bounds inconsistent queued-job pagination", async () => {
    // Given
    let pages = 0;
    vi.mocked(giteaRequest).mockImplementation(async (_credentials, method, path) => {
      if (method === "GET" && path.endsWith("/hooks")) return Response.json([]);
      if (method === "POST" && path.endsWith("/hooks")) return new Response(null, { status: 201 });
      pages += 1;
      return Response.json({ total_count: 10_100, jobs: queuedJobs(1, 100) }, {
        headers: { Link: '<http://gitea/api/v1/orgs/dim-project/actions/jobs?status=queued&page=101&limit=100>; rel="last"' }
      });
    });

    // When / Then
    await expect(giteaCiCoordinator.ensureWorkflowJobWebhook(runner, options, project, {
      url: "http://supervisor:8080/workflow-job",
      authorizationHeader: "Bearer replay",
      replayQueuedJob: async () => {}
    })).rejects.toThrow(/pagination exceeded 100 pages/);
    expect(pages).toBe(1);
  });
});

function queuedJobs(first: number, last: number): readonly { readonly id: number; readonly labels: readonly string[]; readonly status: "queued" }[] {
  return Array.from({ length: last - first + 1 }, (_, index) => ({
    id: first + index,
    labels: ["dim-qemu"],
    status: "queued" as const
  }));
}
