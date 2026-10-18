import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createNativeQemuAuthorityClient,
  NativeQemuAuthorityRejectedError,
  type NativeQemuAuthorityClient
} from "./nativeQemuAuthorityClient.js";
import { nativeQemuExecutionAuthorityJson,
  type NativeQemuCapacity, type NativeQemuCredential,
  type NativeQemuSchedulerConfig } from "./nativeQemuSchedulerConfig.js";
import { NativeQemuSchedulerStore, type NativeQemuReviewEvent } from "./nativeQemuSchedulerStore.js";
import { parseNativeQemuReviewEvent } from "./nativeQemuReviewEvent.js";
import { parseNativeQemuTerminalEvent, terminalEventMatchesClaim } from "./nativeQemuTerminalEvent.js";
import { NativeQemuResultReporter } from "./nativeQemuResultReporter.js";

export function configuredNativeQemuSchedulerServer(
  config: NativeQemuSchedulerConfig,
  authority: NativeQemuAuthorityClient = createNativeQemuAuthorityClient(config)
): Server {
  const store = new NativeQemuSchedulerStore(config.database, nativeQemuExecutionAuthorityJson(config));
  const reporter = new NativeQemuResultReporter(store, authority);
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => send(response, 503, { error: "native QEMU scheduler is unavailable" }));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.once("close", () => { reporter.close(); store.close(); });
  return server;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://native-qemu");
    if (url.search !== "") return notFound(response);
    if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200,
      { schemaVersion: 1, serviceId: "qemu-main", status: "ready" });
    if (request.method === "GET" && url.pathname === "/v1/qemu-host-identity") {
      const host = authenticatedHost(request);
      return host === undefined ? authenticationFailure(request, response) : send(response, 200,
        { schemaVersion: 1, serviceId: "qemu-main", role: "qemu-host", hostId: host.hostId,
          capacities: host.capacities.map(({ capacity }) => capacity) });
    }
    const eventStatus = /^\/v1\/qemu-events\/([0-9a-f]{64})\/status$/.exec(url.pathname);
    if (request.method === "GET" && eventStatus !== null) {
      if (!authorized(request, config.credentials.query)) return authenticationFailure(request, response);
      const eventId = eventStatus[1];
      const status = eventId === undefined ? undefined : store.eventStatus(eventId);
      return status === undefined ? notFound(response) : send(response, 200,
        { schemaVersion: 1, serviceId: "qemu-main", eventId, ...status });
    }
    if (request.method === "POST" && url.pathname === "/v1/qemu-events") {
      if (!authorized(request, config.credentials.eventIntake)) return authenticationFailure(request, response);
      const body = record(await readJson(request));
      if (!exactKeys(body, ["schemaVersion", "requestId", "event"])
        || body.schemaVersion !== 1 || !isUuid(body.requestId)) return badRequest(response);
      const event = parseEvent(body.event);
      try { await authority.proveEvent(event, AbortSignal.timeout(5_000)); }
      catch (error) {
        if (error instanceof NativeQemuAuthorityRejectedError) {
          return send(response, error.status, { error: "native QEMU event is stale" });
        }
        throw error;
      }
      const intake = store.enqueue(event, config.eligibilityLeaseMilliseconds);
      return send(response, intake.result === "created" ? 201 : 200,
        { schemaVersion: 2, serviceId: config.serviceId, serviceGenerationId: store.serviceGenerationId(),
          eventId: event.eventId, eligibilityGeneration: intake.eligibilityGeneration,
          eligibilityExpiresAt: intake.expiresAt, recorded: true });
    }
    if (request.method === "POST" && url.pathname === "/v1/qemu-host-claims") {
      const host = authenticatedHost(request);
      if (host === undefined) return authenticationFailure(request, response);
      const body = record(await readJson(request));
      if (!exactKeys(body, ["schemaVersion", "requestId", "capacity"])
        || body.schemaVersion !== 1 || !isUuid(body.requestId)) return badRequest(response);
      const capacity = capacityFor(host.capacities, body.capacity);
      if (capacity === undefined || typeof body.requestId !== "string") return notFound(response);
      const replay = store.assignment(body.requestId, host.hostId, capacity.capacity);
      if (replay !== undefined) return send(response, 200,
        { schemaVersion: 1, serviceId: "qemu-main", ...replay });
      for (;;) {
        const claim = store.reserve({ requestId: body.requestId, hostId: host.hostId,
          capacity: capacity.capacity, leaseMilliseconds: config.claimLeaseMilliseconds });
        if (claim === undefined) return empty(response);
        try {
          const attempt = await authority.issue(claim, capacity, AbortSignal.timeout(10_000));
          store.activate(claim.claimId, attempt);
          return send(response, 201, { schemaVersion: 1, serviceId: "qemu-main", claim, attempt });
        } catch (error) {
          if (!(error instanceof NativeQemuAuthorityRejectedError)) throw error;
          store.supersedeReservation(claim.claimId);
        }
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/qemu-host-claim-renewals") {
      const host = authenticatedHost(request);
      if (host === undefined) return authenticationFailure(request, response);
      const body = record(await readJson(request));
      if (!exactKeys(body, ["schemaVersion", "requestId", "claimId", "capacity"])
        || body.schemaVersion !== 1 || !isUuid(body.requestId) || !isUuid(body.claimId) || typeof body.capacity !== "string"
        || capacityFor(host.capacities, body.capacity) === undefined) return notFound(response);
      const leaseExpiresAt = store.renew(body.claimId, host.hostId, body.capacity, config.claimLeaseMilliseconds);
      return send(response, 200, { schemaVersion: 1, claimId: body.claimId, leaseExpiresAt });
    }
    if (request.method === "POST" && url.pathname === "/v1/qemu-host-candidate-leases") {
      const host = authenticatedHost(request);
      if (host === undefined) return authenticationFailure(request, response);
      const body = record(await readJson(request));
      if (!exactKeys(body, ["schemaVersion", "requestId", "claimId", "attemptId", "descriptorDigest"])
        || body.schemaVersion !== 1 || !isUuid(body.requestId) || !isUuid(body.claimId)
        || !isUuid(body.attemptId) || typeof body.descriptorDigest !== "string") return badRequest(response);
      const claim = store.current(body.claimId);
      if (claim === undefined || claim.hostId !== host.hostId || claim.attemptId !== body.attemptId
        || claim.descriptorDigest !== body.descriptorDigest) return notFound(response);
      const lease = await authority.candidateLease(claim, body.attemptId, body.descriptorDigest,
        AbortSignal.timeout(10_000));
      return send(response, 201, { schemaVersion: 1, serviceId: "qemu-main", requestId: body.requestId, ...lease });
    }
    if (request.method === "POST" && url.pathname === "/v1/qemu-host-results") {
      const host = authenticatedHost(request);
      if (host === undefined) return authenticationFailure(request, response);
      const body = record(await readJson(request));
      if (!exactKeys(body, ["schemaVersion", "requestId", "claimId", "capacity", "cleanupComplete", "terminalEvent"])
        || body.schemaVersion !== 1 || !isUuid(body.requestId) || !isUuid(body.claimId)
        || typeof body.capacity !== "string" || body.cleanupComplete !== true) return badRequest(response);
      if (capacityFor(host.capacities, body.capacity) === undefined) return notFound(response);
      const owned = store.finalization(body.claimId, host.hostId, body.capacity);
      if (owned === undefined) return notFound(response);
      let terminalEvent;
      try { terminalEvent = parseNativeQemuTerminalEvent(body.terminalEvent); }
      catch (error) { if (error instanceof Error) return badRequest(response); throw error; }
      if (!terminalEventMatchesClaim(terminalEvent, owned.claim, owned.attempt)) return notFound(response);
      if (owned.state === "completed" && owned.result === undefined) return notFound(response);
      if (owned.result !== undefined && JSON.stringify(owned.result.terminalEvent) !== JSON.stringify(terminalEvent)) {
        return notFound(response);
      }
      store.recordResult({ claimId: owned.claim.claimId, cleanupComplete: true, eventId: terminalEvent.eventId,
        result: terminalEvent.payload.result, terminalEvent });
      reporter.wake();
      return send(response, 202, { schemaVersion: 1, claimId: owned.claim.claimId, accepted: true });
    }
    if (request.method === "POST" && url.pathname === "/v1/qemu-host-recoveries") {
      const host = authenticatedHost(request);
      if (host === undefined) return authenticationFailure(request, response);
      const body = record(await readJson(request));
      if (!exactKeys(body, ["schemaVersion", "requestId", "claimId", "capacity", "cleanupComplete"])
        || body.schemaVersion !== 1 || !isUuid(body.requestId) || !isUuid(body.claimId) || typeof body.capacity !== "string"
        || body.cleanupComplete !== true || capacityFor(host.capacities, body.capacity) === undefined) {
        return badRequest(response);
      }
      const owned = store.finalization(body.claimId, host.hostId, body.capacity);
      if (owned === undefined || owned.result !== undefined) return notFound(response);
      if (owned.state === "completed") return empty(response);
      await authority.revoke(owned.claim, owned.attempt.attemptId, AbortSignal.timeout(10_000));
      store.recover(owned.claim.claimId, host.hostId, owned.claim.capacity);
      return empty(response);
    }
    notFound(response);
  }

  function authenticatedHost(request: IncomingMessage): NativeQemuSchedulerConfig["hosts"][number] | undefined {
    return config.hosts.find((host) => authorized(request, { username: host.hostId, password: host.hostToken }));
  }
  function authenticationFailure(request: IncomingMessage, response: ServerResponse): void {
    const known = [...Object.values(config.credentials), ...Object.values(config.nativeGit).filter(isCredential),
      ...config.hosts.map((host) => ({ username: host.hostId, password: host.hostToken }))];
    send(response, known.some((credential) => authorized(request, credential)) ? 403 : 401,
      { error: known.some((credential) => authorized(request, credential)) ? "forbidden" : "unauthorized" });
  }
}

function parseEvent(value: unknown): NativeQemuReviewEvent {
  try { return parseNativeQemuReviewEvent(value); }
  catch (error) {
    if (error instanceof Error) throw new NativeQemuSchedulerHttpError("native QEMU event is invalid", { cause: error });
    throw error;
  }
}
function capacityFor(capacities: readonly NativeQemuCapacity[], value: unknown): NativeQemuCapacity | undefined {
  return typeof value === "string" ? capacities.find(({ capacity }) => capacity === value) : undefined;
}
function authorized(request: IncomingMessage, credential: NativeQemuCredential): boolean {
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw new NativeQemuSchedulerHttpError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 256 * 1024) throw new NativeQemuSchedulerHttpError();
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new NativeQemuSchedulerHttpError();
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}
function exactKeys(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(`${JSON.stringify(body)}\n`);
}
function empty(response: ServerResponse): void { response.writeHead(204, { "cache-control": "no-store" }).end(); }
function badRequest(response: ServerResponse): void { send(response, 400, { error: "invalid native QEMU request" }); }
function notFound(response: ServerResponse): void { send(response, 404, { error: "not found" }); }
function isCredential(value: unknown): value is NativeQemuCredential {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "username");
}
class NativeQemuSchedulerHttpError extends Error { readonly name = "NativeQemuSchedulerHttpError"; }
