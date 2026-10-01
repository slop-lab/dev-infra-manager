import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { UserError } from "./errors.js";
import { OrdinaryCiPoolStore, type OrdinaryCiPoolLease, type StoredOrdinaryPoolClaim } from "./ordinaryCiPoolStore.js";

export type OrdinaryCiPoolProject = {
  readonly projectId: string;
  readonly projectName: string;
  readonly organization: string;
  readonly organizationId: number;
  readonly webhookToken: string;
};

export type OrdinaryCiPoolHost = {
  readonly hostId: string;
  readonly token: string;
  readonly capacities: readonly string[];
};

export type OrdinaryCiPoolServiceConfig = {
  readonly schemaVersion: 1;
  readonly database: string;
  readonly jobImage: string;
  readonly runnerLabel: string;
  readonly projects: readonly OrdinaryCiPoolProject[];
  readonly hosts: readonly OrdinaryCiPoolHost[];
};

const MAX_BODY_BYTES = 65_536;
const DEFAULT_LEASE = { leaseMilliseconds: 60_000, now: Date.now } as const;

export function configuredOrdinaryCiPoolServer(
  config: OrdinaryCiPoolServiceConfig,
  lease: OrdinaryCiPoolLease = DEFAULT_LEASE
): Server {
  assertOrdinaryCiPoolServiceConfig(config);
  const projects = new Map(config.projects.map((project) => [project.projectId, project]));
  const hosts = new Map(config.hosts.map((host) => [host.hostId, host]));
  const store = new OrdinaryCiPoolStore(config.database, lease);
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      sendJson(response, error instanceof UserError ? 400 : 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  server.once("close", () => store.close());
  return server;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://dim-ordinary-pool");
    if (request.method === "GET" && url.pathname === "/healthz") return sendJson(response, 200, { ok: true });
    const webhook = /^\/v1\/webhooks\/([^/]+)\/workflow-job$/.exec(url.pathname);
    if (request.method === "POST" && webhook !== null) {
      const projectId = decodeURIComponent(webhook[1] ?? "");
      const project = projects.get(projectId);
      if (project === undefined || request.headers["x-gitea-event"] !== "workflow_job"
        || request.headers["x-gitea-hook-installation-target-type"] !== "organization"
        || !authorized(request, project.webhookToken)) return sendJson(response, 404, { error: "not found" });
      const body = record(await readJson(request));
      const workflowJob = record(body.workflow_job);
      const organization = record(body.organization);
      const repository = record(body.repository);
      const owner = record(repository.owner);
      record(body.sender);
      const organizationId = positiveInteger(organization.id, "webhook organization ID");
      const ownerId = positiveInteger(owner.id, "webhook repository owner ID");
      if (typeof organization.name !== "string" || typeof owner.login !== "string"
        || typeof repository.full_name !== "string") throw new UserError("webhook organization attribution is invalid");
      if (organizationId !== project.organizationId || ownerId !== project.organizationId
        || organization.name !== project.organization || owner.login !== project.organization
        || !repository.full_name.startsWith(`${project.organization}/`)) return sendJson(response, 404, { error: "not found" });
      if (body.action !== "queued" && body.action !== "in_progress" && body.action !== "completed") {
        throw new UserError("invalid workflow job action");
      }
      const jobId = positiveInteger(workflowJob.id, "workflow job ID");
      const labels = stringArray(workflowJob.labels, "workflow job labels");
      if (body.action === "queued" && labels.includes(config.runnerLabel)) {
        store.recordQueued(projectId, jobId);
      } else if (body.action !== "queued") {
        store.recordTerminal(projectId, jobId, body.action === "completed");
      }
      return sendJson(response, 202, {});
    }
    if (request.method === "POST" && url.pathname === "/v1/claims") {
      const body = record(await readJson(request));
      exactKeys(body, ["hostId", "capacity", "requestId"]);
      const hostId = identifier(body.hostId, "host ID");
      const host = hosts.get(hostId);
      if (host === undefined || request.headers["x-dim-host"] !== hostId || !authorized(request, host.token)) {
        return sendJson(response, 404, { error: "not found" });
      }
      const capacity = identifier(body.capacity, "capacity");
      const requestId = identifier(body.requestId, "request ID");
      if (!host.capacities.includes(capacity)) return sendJson(response, 404, { error: "not found" });
      const claim = store.claim(hostId, capacity, requestId);
      if (claim === undefined) {
        const expiredClaim = store.expired(hostId, capacity);
        return expiredClaim === undefined
          ? sendEmpty(response, 204)
          : sendJson(response, 409, { expiredClaim: recoveryClaim(expiredClaim) });
      }
      return sendClaim(response, { claim, config, leaseMilliseconds: lease.leaseMilliseconds });
    }
    const renew = /^\/v1\/claims\/([^/]+)\/renew$/.exec(url.pathname);
    if (request.method === "POST" && renew !== null) {
      const claimId = decodeURIComponent(renew[1] ?? "");
      const body = record(await readJson(request));
      exactKeys(body, ["hostId"]);
      const hostId = identifier(body.hostId, "host ID");
      const host = hosts.get(hostId);
      if (host === undefined || request.headers["x-dim-host"] !== hostId || !authorized(request, host.token)) {
        return sendJson(response, 404, { error: "not found" });
      }
      const leaseExpiresAt = store.renew(claimId, hostId);
      return leaseExpiresAt === undefined
        ? sendJson(response, 409, { error: "claim lease is not active" })
        : sendJson(response, 200, { leaseMilliseconds: lease.leaseMilliseconds });
    }
    const recover = /^\/v1\/claims\/([^/]+)\/recover$/.exec(url.pathname);
    if (request.method === "POST" && recover !== null) {
      const claimId = decodeURIComponent(recover[1] ?? "");
      const body = record(await readJson(request));
      exactKeys(body, ["hostId", "capacity"]);
      const hostId = identifier(body.hostId, "host ID");
      const host = hosts.get(hostId);
      const capacity = identifier(body.capacity, "capacity");
      if (host === undefined || request.headers["x-dim-host"] !== hostId || !authorized(request, host.token)
        || !host.capacities.includes(capacity)) return sendJson(response, 404, { error: "not found" });
      return store.recover(claimId, hostId, capacity)
        ? sendEmpty(response, 204)
        : sendJson(response, 409, { error: "expired claim is not recoverable" });
    }
    const release = /^\/v1\/claims\/([^/]+)\/release$/.exec(url.pathname);
    if (request.method === "POST" && release !== null) {
      const claimId = decodeURIComponent(release[1] ?? "");
      const body = record(await readJson(request));
      exactKeys(body, ["hostId"]);
      const hostId = identifier(body.hostId, "host ID");
      const host = hosts.get(hostId);
      if (host === undefined || request.headers["x-dim-host"] !== hostId || !authorized(request, host.token)) {
        return sendJson(response, 404, { error: "not found" });
      }
      if (!store.release(claimId, hostId)) return sendJson(response, 409, { error: "claim is not active" });
      return sendEmpty(response, 204);
    }
    sendJson(response, 404, { error: "not found" });
  }
}

function recoveryClaim(claim: StoredOrdinaryPoolClaim): Readonly<Record<string, string>> {
  return { claimId: claim.claimId, projectId: claim.projectId };
}

function sendClaim(
  response: ServerResponse,
  value: {
    readonly claim: StoredOrdinaryPoolClaim;
    readonly config: OrdinaryCiPoolServiceConfig;
    readonly leaseMilliseconds: number;
  }
): void {
  const { claim, config } = value;
  const project = config.projects.find((candidate) => candidate.projectId === claim.projectId);
  if (project === undefined) throw new UserError("ordinary CI pool claim references an unenrolled Project");
  sendJson(response, 200, {
    claimId: claim.claimId,
    jobId: claim.jobId,
    projectId: project.projectId,
    projectName: project.projectName,
    organization: project.organization,
    organizationId: project.organizationId,
    jobImage: config.jobImage,
    runnerLabel: config.runnerLabel,
    leaseMilliseconds: value.leaseMilliseconds
  });
}

export function assertOrdinaryCiPoolServiceConfig(config: OrdinaryCiPoolServiceConfig): void {
  if (config.schemaVersion !== 1) throw new UserError("ordinary CI pool schemaVersion must be 1");
  if (config.database.length === 0) throw new UserError("ordinary CI pool database path must not be empty");
  image(config.jobImage);
  identifier(config.runnerLabel, "runner label");
  unique(config.projects.map((project) => project.projectId), "Project IDs");
  unique(config.projects.map((project) => project.organizationId), "organization IDs");
  unique(config.hosts.map((host) => host.hostId), "host IDs");
  for (const project of config.projects) {
    identifier(project.projectId, "Project ID");
    identifier(project.projectName, "Project name");
    identifier(project.organization, "organization");
    positiveInteger(project.organizationId, "organization ID");
    if (!project.organization.startsWith("dim-")) throw new UserError("ordinary CI pool organizations must be DIM-owned");
    if (project.webhookToken.length < 8) throw new UserError("ordinary CI pool webhook tokens must not be empty");
  }
  for (const host of config.hosts) {
    identifier(host.hostId, "host ID");
    if (host.token.length < 8) throw new UserError("ordinary CI pool host tokens must not be empty");
    unique(host.capacities, `capacities for host '${host.hostId}'`);
    for (const capacity of host.capacities) identifier(capacity, "capacity");
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new UserError("request body is too large");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) { if (error instanceof SyntaxError) throw new UserError("request body must be valid JSON"); throw error; }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UserError("request body must be an object");
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => value[key] === undefined)) {
    throw new UserError("request body has invalid fields");
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw new UserError(`${label} is invalid`);
  return value;
}

function image(value: string): void {
  if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/.test(value)) {
    throw new UserError("ordinary CI pool job image must be digest-pinned without a tag");
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new UserError(`${label} must be a positive integer`);
  return Number(value);
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new UserError(`${label} must be strings`);
  return value;
}

function unique(values: readonly (string | number)[], label: string): void {
  if (new Set(values).size !== values.length) throw new UserError(`ordinary CI pool ${label} must be unique`);
}

function sendEmpty(response: ServerResponse, status: number): void { response.writeHead(status).end(); }
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}
