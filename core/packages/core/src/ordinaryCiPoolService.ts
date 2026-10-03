import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { UserError } from "./errors.js";
import { ordinaryCiPoolClaimResponse, type OrdinaryCiPoolAdmissionInput } from "./ordinaryCiPoolAdmission.js";
import { OrdinaryCiPoolAdmissionStore } from "./ordinaryCiPoolAdmissionStore.js";
import {
  assertPoolImage, assertUniquePoolValues, authorizedPoolRequest, exactPoolKeys, poolIdentifier,
  poolPositiveInteger, poolRecord, poolStringArray, readPoolJson, sendPoolEmpty, sendPoolJson
} from "./ordinaryCiPoolHttp.js";
import { OrdinaryCiPoolStore, type OrdinaryCiPoolLease, type StoredOrdinaryPoolClaim } from "./ordinaryCiPoolStore.js";

export type OrdinaryCiPoolHost = {
  readonly hostId: string;
  readonly token: string;
  readonly capacities: readonly string[];
};

export type OrdinaryCiPoolServiceConfig = {
  readonly schemaVersion: 2;
  readonly serviceId: string;
  readonly database: string;
  readonly jobImage: string;
  readonly webhookBaseUrl: string;
  readonly registrarToken: string;
  readonly admissionLeaseMilliseconds: number;
  readonly hosts: readonly OrdinaryCiPoolHost[];
};

const DEFAULT_LEASE = { leaseMilliseconds: 60_000, now: Date.now } as const;

export function configuredOrdinaryCiPoolServer(
  config: OrdinaryCiPoolServiceConfig,
  lease: OrdinaryCiPoolLease = DEFAULT_LEASE
): Server {
  assertOrdinaryCiPoolServiceConfig(config);
  const hosts = new Map(config.hosts.map((host) => [host.hostId, host]));
  const store = new OrdinaryCiPoolStore(config.database, lease);
  const admissions = new OrdinaryCiPoolAdmissionStore(config.database, config.serviceId, {
    now: lease.now,
    admissionLeaseMilliseconds: config.admissionLeaseMilliseconds
  });
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => sendPoolJson(response, error instanceof UserError ? 400 : 500, {
      error: error instanceof Error ? error.message : String(error)
    }));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  server.once("close", () => { admissions.close(); store.close(); });
  return server;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://dim-ordinary-pool");
    if (request.method === "GET" && url.pathname === "/healthz") {
      return sendPoolJson(response, 200, { ok: true, serviceId: config.serviceId, jobImage: config.jobImage });
    }
    if (request.method === "POST" && url.pathname === "/v1/admissions") {
      if (!authorizedPoolRequest(request, config.registrarToken)) return notFound(response);
      const input = parseAdmission(await readPoolJson(request), config.jobImage);
      const result = admissions.admit(input);
      return sendPoolJson(response, 200, {
        admissionId: result.admission.admissionId,
        serviceId: config.serviceId,
        webhookUrl: `${config.webhookBaseUrl}/v1/webhooks/${encodeURIComponent(input.projectId)}/workflow-job`,
        webhookToken: result.webhookToken,
        leaseMilliseconds: config.admissionLeaseMilliseconds
      });
    }
    const revoke = /^\/v1\/admissions\/([^/]+)\/revoke$/.exec(url.pathname);
    if (request.method === "POST" && revoke !== null) {
      if (!authorizedPoolRequest(request, config.registrarToken)) return notFound(response);
      const body = poolRecord(await readPoolJson(request));
      exactPoolKeys(body, ["projectId"]);
      const projectId = poolIdentifier(body.projectId, "Project ID");
      return admissions.revoke(projectId, decodeURIComponent(revoke[1] ?? ""))
        ? sendPoolEmpty(response, 204) : sendPoolJson(response, 409, { error: "admission is not active" });
    }
    const replay = /^\/v1\/admissions\/([^/]+)\/jobs$/.exec(url.pathname);
    if (request.method === "POST" && replay !== null) {
      if (!authorizedPoolRequest(request, config.registrarToken)) return notFound(response);
      const projectId = decodeURIComponent(replay[1] ?? "");
      const admission = admissions.activeByProject(projectId);
      if (admission === undefined) return notFound(response);
      const body = poolRecord(await readPoolJson(request));
      exactPoolKeys(body, ["jobId", "labels"]);
      queueMatching(store, admission, poolPositiveInteger(body.jobId, "workflow job ID"), poolStringArray(body.labels, "workflow job labels"));
      return sendPoolJson(response, 202, {});
    }
    const webhook = /^\/v1\/webhooks\/([^/]+)\/workflow-job$/.exec(url.pathname);
    if (request.method === "POST" && webhook !== null) {
      return handleWebhook(request, response, decodeURIComponent(webhook[1] ?? ""));
    }
    if (request.method === "POST" && url.pathname === "/v1/claims") return handleClaim(request, response);
    const claimRoute = /^\/v1\/claims\/([^/]+)\/(renew|recover|release)$/.exec(url.pathname);
    if (request.method === "POST" && claimRoute !== null) {
      return handleClaimMutation(request, response, decodeURIComponent(claimRoute[1] ?? ""), claimRoute[2] ?? "");
    }
    notFound(response);
  }

  async function handleWebhook(request: IncomingMessage, response: ServerResponse, projectId: string): Promise<void> {
    const admission = admissions.activeByProject(projectId);
    const token = admissions.webhookToken(projectId);
    if (admission === undefined || token === undefined || request.headers["x-gitea-event"] !== "workflow_job"
      || request.headers["x-gitea-hook-installation-target-type"] !== "organization"
      || !authorizedPoolRequest(request, token)) return notFound(response);
    const body = poolRecord(await readPoolJson(request));
    const workflowJob = poolRecord(body.workflow_job);
    const organization = poolRecord(body.organization);
    const repository = poolRecord(body.repository);
    const owner = poolRecord(repository.owner);
    poolRecord(body.sender);
    if (poolPositiveInteger(organization.id, "webhook organization ID") !== admission.organizationId
      || poolPositiveInteger(owner.id, "webhook repository owner ID") !== admission.organizationId
      || organization.name !== admission.organization || owner.login !== admission.organization
      || typeof repository.full_name !== "string" || !repository.full_name.startsWith(`${admission.organization}/`)) {
      return notFound(response);
    }
    const jobId = poolPositiveInteger(workflowJob.id, "workflow job ID");
    if (body.action === "queued") queueMatching(store, admission, jobId, poolStringArray(workflowJob.labels, "workflow job labels"));
    else if (body.action === "in_progress" || body.action === "completed") store.recordTerminal(projectId, jobId, body.action === "completed");
    else throw new UserError("invalid workflow job action");
    sendPoolJson(response, 202, {});
  }

  async function handleClaim(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = poolRecord(await readPoolJson(request));
    exactPoolKeys(body, ["hostId", "capacity", "requestId"]);
    const hostId = poolIdentifier(body.hostId, "host ID");
    const capacity = poolIdentifier(body.capacity, "capacity");
    const host = authenticatedHost(request, hostId, capacity);
    if (host === undefined) return notFound(response);
    const claim = store.claim(hostId, capacity, poolIdentifier(body.requestId, "request ID"), admissions.activeIds());
    if (claim === undefined) {
      const expired = store.expired(hostId, capacity);
      return expired === undefined ? sendPoolEmpty(response, 204) : sendPoolJson(response, 409, { expiredClaim: recoveryClaim(expired) });
    }
    sendPoolJson(response, 200, ordinaryCiPoolClaimResponse(claim, admissions.activeById(claim.admissionId), lease.leaseMilliseconds));
  }

  async function handleClaimMutation(request: IncomingMessage, response: ServerResponse, claimId: string, action: string): Promise<void> {
    const body = poolRecord(await readPoolJson(request));
    const keys = action === "recover" ? ["hostId", "capacity"] : ["hostId"];
    exactPoolKeys(body, keys);
    const hostId = poolIdentifier(body.hostId, "host ID");
    const capacity = action === "recover" ? poolIdentifier(body.capacity, "capacity") : undefined;
    if (authenticatedHost(request, hostId, capacity) === undefined) return notFound(response);
    if (action === "renew") {
      return store.renew(claimId, hostId, admissions.activeIds()) === undefined
        ? sendPoolJson(response, 409, { error: "claim lease is not active" })
        : sendPoolJson(response, 200, { leaseMilliseconds: lease.leaseMilliseconds });
    }
    if (action === "release") return store.release(claimId, hostId)
      ? sendPoolEmpty(response, 204) : sendPoolJson(response, 409, { error: "claim is not active" });
    if (capacity === undefined) throw new UserError("claim recovery capacity is required");
    const result = store.recover(claimId, hostId, capacity, admissions.activeIds());
    return result === "rejected" ? sendPoolJson(response, 409, { error: "expired claim is not recoverable" }) : sendPoolEmpty(response, 204);
  }

  function authenticatedHost(request: IncomingMessage, hostId: string, capacity?: string): OrdinaryCiPoolHost | undefined {
    const host = hosts.get(hostId);
    return host !== undefined && request.headers["x-dim-host"] === hostId && authorizedPoolRequest(request, host.token)
      && (capacity === undefined || host.capacities.includes(capacity)) ? host : undefined;
  }
}

function parseAdmission(value: unknown, jobImage: string): OrdinaryCiPoolAdmissionInput {
  const input = poolRecord(value);
  const fields = ["projectId", "projectName", "organization", "organizationId", "sourceRef", "sourceCommit", "configDigest", "jobImage", "runnerLabels"];
  exactPoolKeys(input, fields);
  const parsed = {
    projectId: poolIdentifier(input.projectId, "Project ID"), projectName: poolIdentifier(input.projectName, "Project name"),
    organization: poolIdentifier(input.organization, "organization"), organizationId: poolPositiveInteger(input.organizationId, "organization ID"),
    sourceRef: String(input.sourceRef), sourceCommit: String(input.sourceCommit), configDigest: String(input.configDigest),
    jobImage: String(input.jobImage), runnerLabels: poolStringArray(input.runnerLabels, "runner labels")
  };
  if (!parsed.organization.startsWith("dim-") || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(parsed.sourceRef)
    || !/^[0-9a-f]{40,64}$/.test(parsed.sourceCommit) || !/^[0-9a-f]{64}$/.test(parsed.configDigest)
    || parsed.jobImage !== jobImage || parsed.runnerLabels.some((label) => !/^[a-z0-9][a-z0-9._-]*$/.test(label))) {
    throw new UserError("ordinary CI pool admission is not exact reviewed policy");
  }
  return parsed;
}

function queueMatching(store: OrdinaryCiPoolStore, admission: OrdinaryCiPoolAdmissionInput & { readonly admissionId: string }, jobId: number, labels: readonly string[]): void {
  if (labels.some((label) => admission.runnerLabels.includes(label))) store.recordQueued(admission.projectId, jobId, admission.admissionId);
}

function recoveryClaim(claim: StoredOrdinaryPoolClaim): Readonly<Record<string, string>> {
  return { claimId: claim.claimId, projectId: claim.projectId, admissionId: claim.admissionId };
}

function notFound(response: ServerResponse): void { sendPoolJson(response, 404, { error: "not found" }); }

export function assertOrdinaryCiPoolServiceConfig(config: OrdinaryCiPoolServiceConfig): void {
  if (config.schemaVersion !== 2) throw new UserError("ordinary CI pool schemaVersion must be 2");
  poolIdentifier(config.serviceId, "service ID");
  if (config.database.length === 0) throw new UserError("ordinary CI pool database path must not be empty");
  assertPoolImage(config.jobImage);
  if (config.registrarToken.length < 8) throw new UserError("ordinary CI pool registrar token must not be empty");
  if (!Number.isSafeInteger(config.admissionLeaseMilliseconds) || config.admissionLeaseMilliseconds < 1) throw new UserError("ordinary CI pool admission lease must be positive");
  const webhookBase = new URL(config.webhookBaseUrl);
  if (!(["http:", "https:"].includes(webhookBase.protocol)) || webhookBase.username !== "" || webhookBase.password !== ""
    || webhookBase.search !== "" || webhookBase.hash !== "" || (webhookBase.pathname !== "" && webhookBase.pathname !== "/")) {
    throw new UserError("ordinary CI pool webhookBaseUrl must be an HTTP origin");
  }
  assertUniquePoolValues(config.hosts.map((host) => host.hostId), "host IDs");
  for (const host of config.hosts) {
    poolIdentifier(host.hostId, "host ID");
    if (host.token.length < 8 || host.token === config.registrarToken) throw new UserError("ordinary CI pool host and registrar tokens must be separate");
    assertUniquePoolValues(host.capacities, `capacities for host '${host.hostId}'`);
    for (const capacity of host.capacities) poolIdentifier(capacity, "capacity");
  }
}
