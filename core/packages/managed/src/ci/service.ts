import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { executionEventSchema } from "@slop-lab/dim-native-git/execution";
import type { NativeOrdinaryAuthorityConfig } from "../nativeOrdinaryAuthorityConfig.js";
import { ExecutionStore } from "./store.js";
import { ExecutionConflictError, type WorkerIdentity } from "./execution.js";
import { nativeGitExecutionSource, StaleExecutionSourceError, type ExecutionSource } from "./source.js";

const identity = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const ownership = z.object({ slotId: identity, leaseToken: z.string().min(32).max(128) });
const claimRequest = z.object({ requestId: z.string().uuid(), slotId: identity }).strict();
export function configuredExecutionServer(input: {
  readonly config: NativeOrdinaryAuthorityConfig; readonly stateDirectory: string;
  readonly readinessToken: string; readonly activationToken: string; readonly expectedGenerationId: string;
  readonly source?: ExecutionSource; readonly now?: () => number;
}) {
  const config = input.config;
  const generation = input.expectedGenerationId;
  const activation = createHash("sha256").update(input.activationToken).digest("hex");
  const workers: WorkerIdentity[] = config.hosts.map((host) => ({ id: host.hostId, token: host.hostToken,
    slots: host.capacities.map((slot) => ({ id: slot.capacity, kind: "ordinary-sysbox",
      profile: { runnerBaseImage: slot.runnerBaseImage, jobBaseImage: slot.jobBaseImage, bounds: slot.bounds } })) }));
  const store = new ExecutionStore(join(input.stateDirectory, "executions.sqlite3"), generation,
    config.claimLeaseMilliseconds, input.now);
  const source = input.source ?? nativeGitExecutionSource(config.nativeGit, generation);
  const shutdown = new AbortController();
  const publisher = publishResults();
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      send(response, error instanceof z.ZodError ? 400 : error instanceof ExecutionConflictError ? 409 : 503,
        { error: error instanceof z.ZodError ? "invalid CI request" : "CI operation is unavailable" });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 1_000;
  let closed = false;
  async function closeStore() { shutdown.abort(); await publisher; if (!closed) { closed = true; store.close(); } }
  server.once("close", () => { void closeStore(); });
  return { server, store, async close() {
    shutdown.abort(); server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await closeStore();
  } };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://dim-ci");
    if (url.search !== "") return send(response, 404, {});
    if (request.method === "GET" && url.pathname === "/readyz") {
      return send(response, bearer(request, input.readinessToken) ? 200 : 404, { schemaVersion: 1, status: "ready" });
    }
    if (request.method === "POST" && url.pathname === "/v1/activation") {
      const local = request.socket.remoteAddress === "127.0.0.1" || request.socket.remoteAddress === "::ffff:127.0.0.1";
      if (!local || !bearer(request, input.activationToken)) return send(response, 404, {});
      const body = z.object({ schemaVersion: z.literal(1), generationId: z.literal(generation) }).strict().parse(await read(request));
      store.activate(activation); return send(response, 200, { ...body, activated: true });
    }
    if (!store.activated(activation)) return send(response, 503, { error: "CI requires generation activation" });
    if (request.method === "POST" && url.pathname === "/v1/jobs") {
      if (!basic(request, config.credentials.webhook.username, config.credentials.webhook.password)) return unauthorized(response);
      const body = z.object({ generationId: z.literal(generation), event: executionEventSchema }).strict().parse(await read(request));
      if (body.event.executionKind !== "ordinary-sysbox") return send(response, 409, { error: "execution runtime is unavailable" });
      const execution = store.enqueue(body.event);
      return send(response, 202, { executionId: execution.id, eventId: execution.event.eventId, generationId: generation });
    }
    if (request.method === "GET" && url.pathname === "/v1/jobs") {
      if (!basic(request, config.credentials.query.username, config.credentials.query.password)) return unauthorized(response);
      return send(response, 200, store.list().map(({ leaseToken: _token, ...job }) => job));
    }
    const worker = workers.find((worker) => basic(request, worker.id, worker.token));
    if (worker === undefined) return unauthorized(response);
    if (request.headers["x-dim-generation-id"] !== generation) return send(response, 409, { error: "CI worker generation is stale" });
    if (request.method === "GET" && url.pathname === "/v1/worker") {
      return send(response, 200, { generationId: generation, workerId: worker.id, slots: worker.slots });
    }
    if (request.method === "POST" && url.pathname === "/v1/claims") {
      const body = claimRequest.parse(await read(request));
      const slot = worker.slots.find((slot) => slot.id === body.slotId);
      if (slot === undefined) return send(response, 404, {});
      let assignment = store.reserve(worker.id, slot, body.requestId);
      if (assignment === undefined) return send(response, 204);
      if (assignment.phase !== "assigned" || assignment.grant !== undefined) return send(response, 200, assignment);
      try { assignment = store.attachGrant(assignment.id, await source.authorize(assignment)); }
      catch (error) {
        if (error instanceof StaleExecutionSourceError) { store.reject(assignment.id); return send(response, 204); }
        throw error;
      }
      return send(response, 200, assignment);
    }
    const match = /^\/v1\/executions\/([0-9a-f-]{36})\/(renew|candidate|result|recover)$/.exec(url.pathname);
    if (request.method !== "POST" || match === null) return send(response, 404, {});
    const id = match[1]!, action = match[2]!;
    const raw = await read(request);
    const body = ownership.passthrough().parse(raw);
    const assignment = store.owned(id, worker.id, body.slotId, body.leaseToken);
    if (action === "renew") {
      ownership.strict().parse(raw);
      const renewed = store.renew(id, worker.id, body.slotId, body.leaseToken);
      return send(response, 200, { expiresAt: renewed.leaseExpiresAt, leaseMilliseconds: config.claimLeaseMilliseconds });
    }
    if (action === "candidate") {
      ownership.strict().parse(raw);
      store.renew(id, worker.id, body.slotId, body.leaseToken);
      if (assignment.grant === undefined) throw new ExecutionConflictError("execution has no grant");
      return send(response, 200, await source.candidate(assignment.grant));
    }
    if (action === "recover") {
      ownership.extend({ cleanupComplete: z.literal(true) }).strict().parse(raw);
      store.recover(id, worker.id, body.slotId, body.leaseToken);
      return send(response, 200, { accepted: true });
    }
    const resultBody = ownership.extend({ result: z.unknown() }).strict().parse(raw);
    store.finish(id, worker.id, body.slotId, body.leaseToken, resultBody.result as never);
    send(response, 200, { accepted: true });
  }
  async function publishResults(): Promise<void> {
    while (!shutdown.signal.aborted) {
      for (const job of store.pendingResults()) {
        try {
          if (job.grant === undefined || job.result === undefined) throw new Error("finished execution lacks evidence");
          await source.publish(job.grant, job.result);
          if (!shutdown.signal.aborted) store.published(job.id, "accepted");
        } catch (error) {
          if (!shutdown.signal.aborted && error instanceof StaleExecutionSourceError) store.published(job.id, "stale");
        }
      }
      try { await delay(100, undefined, { signal: shutdown.signal }); } catch { return; }
    }
  }
}
function basic(request: IncomingMessage, username: string, password: string): boolean {
  return equal(request.headers.authorization ?? "", `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
}
function bearer(request: IncomingMessage, token: string): boolean { return equal(request.headers.authorization ?? "", `Bearer ${token}`); }
function equal(left: string, right: string): boolean { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function unauthorized(response: ServerResponse): void { response.setHeader("WWW-Authenticate", 'Basic realm="DIM CI"'); send(response, 401, {}); }
function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}
async function read(request: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 1024 * 1024) throw new Error("CI request exceeds bound"); chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ExecutionConflictError("CI request is not JSON"); }
}
