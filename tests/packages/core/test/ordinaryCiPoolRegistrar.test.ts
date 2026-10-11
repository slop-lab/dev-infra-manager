import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import type { ProjectRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { configuredOrdinaryCiPoolServer } from "../../../../core/packages/core/src/ordinaryCiPoolService.js";
import { reconcileOrdinaryCiPoolProject } from "../../../../core/packages/core/src/ordinaryCiPoolRegistrar.js";
import { ProcessRunner } from "../../../../core/packages/core/src/runner.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

const IMAGE = `registry.example/dim/common@sha256:${"a".repeat(64)}`;
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, "close");
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ordinary CI trusted host registrar", () => {
  it("auto-admits two protected Projects without sending Gitea credentials to the pool", async () => {
    // Given
    const root = await temporaryRoot();
    const runner = new RecordingRunner();
    const git = await createProtectedRepositories(root, runner);
    const fixture = await startGitea();
    const pool = await startPool(root);
    const options = await hostOptions(root, fixture.endpoint, git);
    const registrarFile = await privateJson(join(root, "registrar.json"), {
      schemaVersion: 1, transport: "loopback-http", endpoint: pool,
      token: "registrar-token", expectedServiceId: "pool-main", expectedJobImage: IMAGE
    });

    // When
    const alpha = await reconcileOrdinaryCiPoolProject(runner, options, { projectName: "alpha", registrarFile });
    const beta = await reconcileOrdinaryCiPoolProject(runner, options, { projectName: "beta", registrarFile });
    const queuedAlpha = await deliverWebhook(fixture.hooks.get("dim-alpha"), pool, 101, "dim-alpha", 41);
    const queuedBeta = await deliverWebhook(fixture.hooks.get("dim-beta"), pool, 202, "dim-beta", 42);
    const claims = await Promise.all([
      claim(pool, "host-a", "request-a"),
      claim(pool, "host-b", "request-b")
    ]);

    // Then
    expect([alpha.serviceId, beta.serviceId]).toEqual(["pool-main", "pool-main"]);
    expect([queuedAlpha.status, queuedBeta.status, ...claims.map((response) => response.status)]).toEqual([202, 202, 200, 200]);
    expect(fixture.registrationRequests).toBe(0);
    expect(runner.calls.some((call) => call.command === "docker")).toBe(false);
    expect(fixture.poolBodies.some((body) => JSON.stringify(body).includes("admin-password"))).toBe(false);
  });

  it.each([
    ["mutable", "registry.example/dim/common:latest", /digest-pinned/],
    ["different", `registry.example/dim/common@sha256:${"b".repeat(64)}`, /common pool image/]
  ] as const)("rejects a %s reviewed image before webhook or Docker mutation", async (_case, reviewedImage, expected) => {
    // Given
    const root = await temporaryRoot();
    const runner = new RecordingRunner();
    const git = await createProtectedRepositories(root, runner, reviewedImage);
    const fixture = await startGitea();
    const pool = await startPool(root);
    const options = await hostOptions(root, fixture.endpoint, git);
    const registrarFile = await privateJson(join(root, "registrar.json"), {
      schemaVersion: 1, transport: "loopback-http", endpoint: pool,
      token: "registrar-token", expectedServiceId: "pool-main", expectedJobImage: IMAGE
    });

    // When
    const rejected = reconcileOrdinaryCiPoolProject(runner, options, { projectName: "alpha", registrarFile });

    // Then
    await expect(rejected).rejects.toThrow(expected);
    expect(fixture.hooks.size).toBe(0);
    expect(fixture.registrationRequests).toBe(0);
    expect(runner.calls.some((call) => call.command === "docker")).toBe(false);
  });

  it("revokes the admission when webhook reconciliation fails", async () => {
    // Given
    const root = await temporaryRoot();
    const runner = new RecordingRunner();
    const git = await createProtectedRepositories(root, runner);
    const fixture = await startGitea(true);
    const pool = await startPool(root);
    const options = await hostOptions(root, fixture.endpoint, git);
    const registrarFile = await privateJson(join(root, "registrar.json"), {
      schemaVersion: 1, transport: "loopback-http", endpoint: pool,
      token: "registrar-token", expectedServiceId: "pool-main", expectedJobImage: IMAGE
    });

    // When
    const rejected = reconcileOrdinaryCiPoolProject(runner, options, { projectName: "alpha", registrarFile });

    // Then
    await expect(rejected).rejects.toThrow(/webhook/);
    const database = new DatabaseSync(join(root, "pool.sqlite3"), { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM admissions").get()).toEqual({ count: 0 });
    database.close();
  });
});

class RecordingRunner implements StreamingCommandRunner {
  readonly calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  readonly #runner = new ProcessRunner();

  async run(command: string, args: string[], options?: Parameters<ProcessRunner["run"]>[2]): Promise<CommandResult> {
    this.calls.push({ command, args });
    return this.#runner.run(command, args, options);
  }

  runStreaming(command: string, args: string[], options?: Parameters<ProcessRunner["runStreaming"]>[2]): Promise<number> {
    return this.#runner.runStreaming(command, args, options);
  }
}

type GitProjects = Readonly<Record<"alpha" | "beta", { readonly bare: string; readonly commit: string }>>;

async function createProtectedRepositories(root: string, runner: RecordingRunner, image = IMAGE): Promise<GitProjects> {
  const entries = await Promise.all(["alpha", "beta"].map(async (name) => {
    const work = join(root, `${name}-work`);
    const bare = join(root, `${name}.git`);
    await mkdir(join(work, ".dim", "ci"), { recursive: true });
    await run(runner, "git", ["init", "--quiet", "--initial-branch=main", work]);
    await run(runner, "git", ["-C", work, "config", "user.name", "DIM test"]);
    await run(runner, "git", ["-C", work, "config", "user.email", "dim@test.invalid"]);
    await writeFile(join(work, ".dim", "ci", "runner.yml"), runnerYaml(image, `dim-${name}`));
    await run(runner, "git", ["-C", work, "add", "."]);
    await run(runner, "git", ["-C", work, "commit", "--quiet", "-m", "reviewed config"]);
    const commit = (await runner.run("git", ["-C", work, "rev-parse", "HEAD"])).stdout.trim();
    await run(runner, "git", ["clone", "--quiet", "--bare", work, bare]);
    return [name, { bare, commit }] as const;
  }));
  return Object.fromEntries(entries) as GitProjects;
}

async function run(runner: RecordingRunner, command: string, args: string[]): Promise<void> {
  const result = await runner.run(command, args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

function runnerYaml(image: string, label: string): string {
  return `schemaVersion: 1\nworkloads:\n  ordinary:\n    labels: [${label}]\n    image: ${image}\n    tools: [bash]\n    capabilities: []\n  integration:\n    labels: [${label}-integration]\n    image: ${IMAGE}\n    tools: [bash, docker]\n    capabilities: [nested-docker]\n`;
}

async function hostOptions(root: string, gitea: string, projects: GitProjects) {
  const giteaFile = await privateJson(join(root, "gitea.json"), {
    schemaVersion: 1, transport: "loopback-http", hostId: "trusted-host",
    apiBaseUrl: `${gitea}/api/v1`, hostBaseUrl: gitea, workspaceBaseUrl: gitea, runnerBaseUrl: gitea,
    credentials: {
      adminUsername: "admin", adminPassword: "admin-password", writerUsername: "writer",
      writerPassword: "writer-password", maintainerUsername: "maintainer", maintainerPassword: "maintainer-password"
    },
    projects: {
      alpha: { id: "project-a", gitNamespace: "dim-alpha", giteaOrganizationId: 41 },
      beta: { id: "project-b", gitNamespace: "dim-beta", giteaOrganizationId: 42 }
    }
  });
  const options = lifecycleOptionsForBackend("sysbox", {
    HOME: root, DIM_STATE_ROOT: join(root, "state"), DIM_GITEA_CONNECTION_FILE: giteaFile
  });
  const state = new LifecycleState(options.stateRoot);
  await state.claimProject(project("alpha", "project-a", 41, projects.alpha));
  await state.claimProject(project("beta", "project-b", 42, projects.beta));
  return options;
}

function project(name: string, id: string, organizationId: number, git: GitProjects["alpha"]): ProjectRecord {
  return {
    schemaVersion: 4, id, name, gitNamespace: `dim-${name}`, giteaOrganizationId: organizationId,
    phase: "ready", rootRepositoryAlias: "root", rootRef: "refs/heads/main",
    repositories: [{ alias: "root", providerRepoId: `dim-${name}/root`, owner: `dim-${name}`,
      hostUrl: git.bare, workspaceUrl: git.bare, phase: "ready", connections: [], protectedPatterns: ["main"],
      protectionPhase: "applied", createdAt: "now", updatedAt: "now" }],
    createdAt: "now", updatedAt: "now"
  };
}

async function startPool(root: string): Promise<string> {
  const server = configuredOrdinaryCiPoolServer({
    schemaVersion: 2, serviceId: "pool-main", database: join(root, "pool.sqlite3"), jobImage: IMAGE,
    webhookBaseUrl: "http://127.0.0.1:0", registrarToken: "registrar-token", admissionLeaseMilliseconds: 60_000,
    hosts: [
      { hostId: "host-a", token: "host-a-token", capacities: ["primary"] },
      { hostId: "host-b", token: "host-b-token", capacities: ["primary"] }
    ]
  });
  return listen(server);
}

async function startGitea(failHooks = false): Promise<{
  readonly endpoint: string;
  readonly hooks: Map<string, { readonly url: string; readonly authorization: string }>;
  readonly poolBodies: unknown[];
  readonly registrationRequests: number;
}> {
  const hooks = new Map<string, { readonly url: string; readonly authorization: string }>();
  const poolBodies: unknown[] = [];
  let registrationRequests = 0;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://gitea").pathname;
    if (path === "/api/v1/version") return json(response, 200, { version: "test" });
    if (path === "/api/v1/user") return json(response, 200, user(request));
    const org = /^\/api\/v1\/orgs\/(dim-(alpha|beta))$/.exec(path);
    if (request.method === "GET" && org !== null) return json(response, 200, { id: org[2] === "alpha" ? 41 : 42, username: org[1] });
    const hook = /^\/api\/v1\/orgs\/(dim-(alpha|beta))\/hooks(?:\/\d+)?$/.exec(path);
    if (hook !== null && request.method === "GET") return json(response, 200, hooks.has(hook[1] ?? "") ? [{ id: 1, config: { url: hooks.get(hook[1] ?? "")?.url } }] : []);
    if (hook !== null && (request.method === "POST" || request.method === "PATCH")) {
      if (failHooks) return json(response, 500, {});
      const body = await requestJson(request); poolBodies.push(body);
      if (isRecord(body) && typeof body.authorization_header === "string" && isRecord(body.config) && typeof body.config.url === "string") {
        hooks.set(hook[1] ?? "", { url: body.config.url, authorization: body.authorization_header });
      }
      return json(response, 200, { id: 1 });
    }
    if (/\/actions\/jobs$/.test(path)) return json(response, 200, { total_count: 0, jobs: [] });
    if (/\/registration-token$/.test(path)) { registrationRequests += 1; return json(response, 200, { token: "unexpected" }); }
    json(response, 404, {});
  });
  const endpoint = await listen(server);
  return { endpoint, hooks, poolBodies, get registrationRequests() { return registrationRequests; } };
}

function user(request: IncomingMessage): Readonly<Record<string, unknown>> {
  const login = Buffer.from((request.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":")[0] ?? "";
  return { login, is_admin: login === "admin" };
}

async function deliverWebhook(hook: { readonly url: string; readonly authorization: string } | undefined, pool: string, jobId: number, organization: string, organizationId: number): Promise<Response> {
  if (hook === undefined) throw new Error("webhook was not installed");
  return fetch(hook.url.replace("http://127.0.0.1:0", pool), {
    method: "POST", headers: { Authorization: hook.authorization, "Content-Type": "application/json", "X-Gitea-Event": "workflow_job", "X-Gitea-Hook-Installation-Target-Type": "organization" },
    body: JSON.stringify({ action: "queued", workflow_job: { id: jobId, labels: [organization] }, organization: { id: organizationId, name: organization }, repository: { full_name: `${organization}/root`, owner: { id: organizationId, login: organization } }, sender: { id: 1 } })
  });
}

function claim(endpoint: string, hostId: string, requestId: string): Promise<Response> {
  return fetch(`${endpoint}/v1/claims`, { method: "POST", headers: { Authorization: `Bearer ${hostId}-token`, "Content-Type": "application/json", "X-DIM-Host": hostId }, body: JSON.stringify({ hostId, capacity: "primary", requestId }) });
}

async function privateJson(file: string, value: unknown): Promise<string> { await writeFile(file, JSON.stringify(value), { mode: 0o600 }); return file; }
async function temporaryRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "dim-ordinary-registrar-")); roots.push(root); return root; }
async function listen(server: Server): Promise<string> { servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }
async function requestJson(request: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === "object" && value !== null && !Array.isArray(value); }
