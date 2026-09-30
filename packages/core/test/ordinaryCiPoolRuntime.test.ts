import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import type { ProjectRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import {
  runOrdinaryCiPoolCapacity,
  runOrdinaryCiPoolCapacityOnce
} from "../../../../core/packages/core/src/ordinaryCiPoolRuntime.js";
import { configuredOrdinaryCiPoolServer } from "../../../../core/packages/core/src/ordinaryCiPoolService.js";
import { REGISTRY_CACHE_IMAGE } from "../../../../core/packages/core/src/registryCache.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

const JOB_IMAGE = `registry.example/dim/job@sha256:${"a".repeat(64)}`;
const RUNNER_IMAGE = `sha256:${"b".repeat(64)}`;
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, "close");
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ordinary CI pool multi-host driver", () => {
  it("continuously serves cross-host bound organizations without matching local Project state", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-runtime-"));
    roots.push(root);
    const registrations: string[] = [];
    const gitea = await startGitea(registrations);
    const pool = await startPool(root);
    const hostA = await hostOptions(root, {
      gitea, pool, hostId: "host-a", token: "host-a-token", localProjects: ["alpha"]
    });
    const hostB = await hostOptions(root, {
      gitea, pool, hostId: "host-b", token: "host-b-token", localProjects: ["beta"]
    });
    const abortA = new AbortController();
    const abortB = new AbortController();
    const runnerA = new RuntimeRunner(undefined, () => abortA.abort());
    const runnerB = new RuntimeRunner(undefined, () => abortB.abort());

    // When
    await webhook(pool, "project-b", "webhook-b", 202);
    await runOrdinaryCiPoolCapacity(runnerA, hostA, "primary", abortA.signal);
    await webhook(pool, "project-a", "webhook-a", 101);
    await runOrdinaryCiPoolCapacity(runnerB, hostB, "primary", abortB.signal);

    // Then
    expect(registrations).toEqual(["dim-beta", "dim-alpha"]);
    for (const runner of [runnerA, runnerB]) {
      const launch = runner.calls.find((call) => call.args[0] === "run");
      expect(launch?.args).toEqual(expect.arrayContaining([
        `GITEA_RUNNER_LABELS=dim-ordinary:docker://${JOB_IMAGE}`
      ]));
      expect(launch?.args.join(" ")).not.toMatch(/docker\.sock|\/dev\/kvm/);
    }
  });

  it("reaps an expired worker before granting replacement capacity after service restart", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-runtime-recovery-"));
    roots.push(root);
    let now = 1_000;
    const database = join(root, "pool.sqlite3");
    const gitea = await startGitea([]);
    const firstPool = await startPool(root, database, { now: () => now, leaseMilliseconds: 100 });
    await webhook(firstPool, "project-a", "webhook-a", 303);
    const original = await poolClaim(firstPool, "host-a", "host-a-token", "original");
    const claim = await original.json() as { readonly claimId: string; readonly projectId: string };
    const firstServer = servers[servers.length - 1];
    if (firstServer === undefined) throw new Error("pool server is missing");
    firstServer.close();
    await once(firstServer, "close");
    servers.splice(servers.indexOf(firstServer), 1);
    now = 1_101;
    const restarted = await startPool(root, database, { now: () => now, leaseMilliseconds: 100 });
    const options = await hostOptions(root, { gitea, pool: restarted, hostId: "host-a", token: "host-a-token" });
    const runner = new RuntimeRunner([
      "true", "dim", "host-a", "primary", claim.claimId, claim.projectId, "ci-ordinary-job"
    ]);

    // When
    const result = await runOrdinaryCiPoolCapacityOnce(runner, options, "primary");

    // Then
    expect(result.status).toBe("completed");
    expect(runner.events.indexOf("docker:remove")).toBeLessThan(runner.events.indexOf("docker:run"));
    expect(runner.maximumActive).toBe(1);
  });

  it("does not claim capacity when runner image resolution fails", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-runtime-image-"));
    roots.push(root);
    const gitea = await startGitea([]);
    const pool = await startPool(root);
    await webhook(pool, "project-a", "webhook-a", 404);
    const options = await hostOptions(root, {
      gitea, pool, hostId: "host-a", token: "host-a-token", runnerImage: "mutable:latest"
    });

    // When
    const failed = runOrdinaryCiPoolCapacityOnce(new RuntimeRunner(), options, "primary");

    // Then
    await expect(failed).rejects.toThrow(/configured CI runner image/);
    expect((await poolClaim(pool, "host-a", "host-a-token", "after-image-failure")).status).toBe(200);
  });

  it("rejects a same-name replacement Gitea organization before registration", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-runtime-org-"));
    roots.push(root);
    const registrations: string[] = [];
    const gitea = await startGitea(registrations, 99);
    const pool = await startPool(root);
    await webhook(pool, "project-a", "webhook-a", 505);
    const options = await hostOptions(root, { gitea, pool, hostId: "host-a", token: "host-a-token" });

    // When
    const run = runOrdinaryCiPoolCapacityOnce(new RuntimeRunner(), options, "primary");

    // Then
    await expect(run).rejects.toThrow(/organization identity/);
    expect(registrations).toEqual([]);
  });

  it("rejects host work while host lifecycle maintenance is stopped", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-runtime-maintenance-"));
    roots.push(root);
    const gitea = await startGitea([]);
    const pool = await startPool(root);
    await webhook(pool, "project-a", "webhook-a", 606);
    const options = await hostOptions(root, { gitea, pool, hostId: "host-a", token: "host-a-token" });
    await new LifecycleState(options.stateRoot).writeHostLifecycle({
      schemaVersion: 2, phase: "stopped", resumeWorkspaces: [], restartCiRunners: [],
      resumeManagedContainers: [], updatedAt: new Date().toISOString()
    });
    const runner = new RuntimeRunner();

    // When
    const run = runOrdinaryCiPoolCapacityOnce(runner, options, "primary");

    // Then
    await expect(run).rejects.toThrow(/DIM host is stopped/);
    expect(runner.calls).toEqual([]);
  });
});

class RuntimeRunner implements StreamingCommandRunner {
  readonly calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  readonly events: string[] = [];
  maximumActive = 0;
  private active: number;

  constructor(private staleLabels?: readonly string[], private readonly afterCleanup?: () => void) {
    this.active = staleLabels === undefined ? 0 : 1;
    this.maximumActive = this.active;
  }

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    if (args[0] === "network" || args[0] === "volume") {
      return { command, args, stdout: "true\n", stderr: "", exitCode: 0 };
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === "dim-registry-cache") {
      return { command, args, stdout: `true|true|${REGISTRY_CACHE_IMAGE}\n`, stderr: "", exitCode: 0 };
    }
    let stdout = "";
    if (args[0] === "run") {
      this.events.push("docker:run");
      this.active += 1;
      this.maximumActive = Math.max(this.maximumActive, this.active);
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const launch = this.calls.find((call) => call.args[0] === "run");
      if (launch === undefined && this.staleLabels === undefined) {
        return { command, args, stdout: "", stderr: `Error: No such container: ${args[2] ?? ""}`, exitCode: 1 };
      }
      const labels = launch?.args.flatMap((value, index, values) => value === "--label" ? [values[index + 1] ?? ""] : []) ?? [];
      const actual = this.staleLabels ?? labels.map((label) => label.slice(label.indexOf("=") + 1));
      stdout = `owned-id|${actual.join("|")}\n`;
    }
    if (args[0] === "container" && args[1] === "rm") {
      this.events.push("docker:remove");
      this.active -= 1;
      this.staleLabels = undefined;
      this.afterCleanup?.();
    }
    return { command, args, stdout, stderr: "", exitCode: 0 };
  }

  async runStreaming(): Promise<number> { return 0; }
}

async function startPool(
  root: string,
  database = join(root, "pool.sqlite3"),
  lease?: { readonly now: () => number; readonly leaseMilliseconds: number }
): Promise<string> {
  const server = configuredOrdinaryCiPoolServer({
    schemaVersion: 1, database, jobImage: JOB_IMAGE, runnerLabel: "dim-ordinary",
    projects: [
      { projectId: "project-a", projectName: "alpha", organization: "dim-alpha", organizationId: 41, webhookToken: "webhook-a" },
      { projectId: "project-b", projectName: "beta", organization: "dim-beta", organizationId: 42, webhookToken: "webhook-b" }
    ],
    hosts: [
      { hostId: "host-a", token: "host-a-token", capacities: ["primary"] },
      { hostId: "host-b", token: "host-b-token", capacities: ["primary"] }
    ]
  }, lease);
  return listen(server);
}

function poolClaim(endpoint: string, hostId: string, token: string, requestId: string): Promise<Response> {
  return fetch(`${endpoint}/v1/claims`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-DIM-Host": hostId },
    body: JSON.stringify({ hostId, capacity: "primary", requestId })
  });
}

async function startGitea(registrations: string[], alphaOrganizationId = 41): Promise<string> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://gitea").pathname;
    if (path === "/api/v1/version") return json(response, 200, { version: "test" });
    if (path === "/api/v1/user") {
      const authorization = request.headers.authorization ?? "";
      const decoded = Buffer.from(authorization.replace(/^Basic /, ""), "base64").toString().split(":")[0] ?? "";
      return json(response, 200, { login: decoded, is_admin: decoded === "admin" });
    }
    const organization = /^\/api\/v1\/orgs\/(dim-[a-z]+)$/.exec(path);
    if (request.method === "GET" && organization !== null) {
      const name = organization[1];
      return json(response, 200, { id: name === "dim-alpha" ? alphaOrganizationId : 42, username: name });
    }
    const match = /^\/api\/v1\/orgs\/(dim-[a-z]+)\/actions\/runners\/registration-token$/.exec(path);
    if (request.method === "POST" && match !== null) {
      registrations.push(match[1] ?? "");
      return json(response, 200, { token: "ephemeral-registration-token" });
    }
    json(response, 404, {});
  });
  return listen(server);
}

async function hostOptions(
  root: string,
  fixture: {
    readonly gitea: string;
    readonly pool: string;
    readonly hostId: string;
    readonly token: string;
    readonly runnerImage?: string;
    readonly localProjects?: readonly ("alpha" | "beta")[];
  }
) {
  const { gitea, pool, hostId, token, runnerImage = RUNNER_IMAGE } = fixture;
  const hostRoot = join(root, hostId);
  const stateRoot = join(hostRoot, "state");
  await writeFile(join(root, `${hostId}-gitea.json`), JSON.stringify({
    schemaVersion: 1, transport: "loopback-http", hostId,
    apiBaseUrl: `${gitea}/api/v1`, hostBaseUrl: gitea, workspaceBaseUrl: gitea, runnerBaseUrl: gitea,
    credentials: {
      adminUsername: "admin", adminPassword: "admin-password",
      writerUsername: "writer", writerPassword: "writer-password",
      maintainerUsername: "maintainer", maintainerPassword: "maintainer-password"
    },
    projects: {
      alpha: { id: "project-a", gitNamespace: "dim-alpha", giteaOrganizationId: 41 },
      beta: { id: "project-b", gitNamespace: "dim-beta", giteaOrganizationId: 42 }
    }
  }), { mode: 0o600 });
  await writeFile(join(root, `${hostId}-pool.json`), JSON.stringify({
    schemaVersion: 1, transport: "loopback-http", endpoint: pool, hostId, token, expectedJobImage: JOB_IMAGE
  }), { mode: 0o600 });
  const options = lifecycleOptionsForBackend("sysbox", {
    HOME: hostRoot, DIM_STATE_ROOT: stateRoot,
    DIM_GITEA_CONNECTION_FILE: join(root, `${hostId}-gitea.json`),
    DIM_ORDINARY_CI_POOL_CONNECTION_FILE: join(root, `${hostId}-pool.json`), DIM_CI_RUNNER_IMAGE: runnerImage
  });
  const state = new LifecycleState(stateRoot);
  for (const name of fixture.localProjects ?? ["alpha", "beta"]) {
    if (name === "alpha") await state.claimProject(project("alpha", "project-a", "dim-alpha", 41));
    else await state.claimProject(project("beta", "project-b", "dim-beta", 42));
  }
  return options;
}

function project(name: string, id: string, gitNamespace: string, giteaOrganizationId: number): ProjectRecord {
  const now = new Date().toISOString();
  return { schemaVersion: 4, id, name, gitNamespace, giteaOrganizationId, phase: "ready", rootRepositoryAlias: "root", repositories: [], createdAt: now, updatedAt: now };
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function webhook(endpoint: string, projectId: string, token: string, jobId: number): Promise<Response> {
  const organization = projectId === "project-b" ? { id: 42, name: "dim-beta" } : { id: 41, name: "dim-alpha" };
  return fetch(`${endpoint}/v1/webhooks/${projectId}/workflow-job`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Gitea-Event": "workflow_job", "X-Gitea-Hook-Installation-Target-Type": "organization" },
    body: JSON.stringify({
      action: "queued",
      workflow_job: { id: jobId, run_id: 700, name: "verify", labels: ["dim-ordinary"], run_attempt: 1 },
      organization, repository: { id: 900, name: "root", full_name: `${organization.name}/root`,
        owner: { id: organization.id, login: organization.name, username: organization.name }
      },
      sender: { id: 7, login: "dim-maintainer", username: "dim-maintainer" }
    })
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
