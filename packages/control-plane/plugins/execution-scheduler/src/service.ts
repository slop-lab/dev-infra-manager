import { ExecutionCapacity } from "./capacity.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ExecutionArtifactStore } from "./artifacts.js";
import { executionArtifactManifestSchema } from "@slop-lab/dim-contracts-execution";
import { executionEventSchema } from "@slop-lab/dim-contracts-ci/execution";
import type { ExecutionServiceConfig } from "./config.js";
import { ExecutionStore } from "./store.js";
import { createTaskBroker } from "./task-broker.js";
import { isTaskExecution, taskDescriptorDigest, taskGrantSchema, taskProfileSchema, type TaskProfile, type ScheduledSlot } from "@slop-lab/dim-contracts-execution";
import type { ExecutionProfile } from "@slop-lab/dim-contracts-ci/aggregate";
import { ExecutionConflictError } from "@slop-lab/dim-contracts-execution";
import { nativeGitExecutionSource, StaleExecutionSourceError, type ExecutionSource } from "./ci-source.js";
import { WorkerRegistry } from "./worker-registry.js";
import { createAdmissionController, sendAdmissionFailure } from "./admission.js";

const identity = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const ownership = z.object({ slotId: identity, leaseToken: z.string().min(32).max(128) });
const claimRequest = z.object({ requestId: z.string().uuid(), slotId: identity }).strict();
export function configuredExecutionServer(input: {
  readonly config: ExecutionServiceConfig; readonly stateDirectory: string;
  readonly readinessToken: string; readonly activationToken: string; readonly expectedGenerationId: string;
  readonly source?: ExecutionSource; readonly now?: () => number;
}) {
  const config = input.config;
  const generation = input.expectedGenerationId;
  const activation = createHash("sha256").update(input.activationToken).digest("hex");
  const store = new ExecutionStore(join(input.stateDirectory, "executions.sqlite3"), generation,
    config.claimLeaseMilliseconds, input.now);
  const artifacts = new ExecutionArtifactStore(join(input.stateDirectory, "artifacts"));
  const registry = new WorkerRegistry(store.database, generation, config, store.now);
  const capacity = new ExecutionCapacity(store, registry, config, generation);
  const workers = () => registry.workers().map((worker) => ({ id: worker.workerId, token: worker.token,
    slots: worker.slots.map((slot): ScheduledSlot<ExecutionProfile | TaskProfile> => "taskType" in slot
      ? { id: slot.id, kind: `task/${slot.taskType}`, profile: { taskType: slot.taskType, handlerRevision: slot.handlerRevision } }
      : { id: slot.id, kind: slot.runtime === "container" ? "ordinary-sysbox" : "qemu", profile: slot.profile }) }));
  const source = input.source ?? (config.nativeGit === undefined ? undefined : nativeGitExecutionSource(config.nativeGit, generation));
  const tasks = createTaskBroker(store);
  const shutdown = new AbortController();
  const admission = createAdmissionController(store, shutdown.signal);
  const publisher = publishResults();
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      if (sendAdmissionFailure(response, error)) return;
      send(response, error instanceof z.ZodError ? 400 : error instanceof ExecutionConflictError ? 409 : 503,
        { error: error instanceof z.ZodError ? "invalid execution request" : "execution operation is unavailable" });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 1_000;
  let closed = false;
  async function closeStore() { shutdown.abort(); tasks.close(); await publisher; if (!closed) { closed = true; store.close(); } }
  server.once("close", () => { void closeStore(); });
  return { server, store, async close() {
    shutdown.abort(); server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await closeStore();
  } };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://dim-execution");
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
    if (!store.activated(activation)) return send(response, 503, { error: "Execution requires generation activation" });
    if (request.method === "POST" && ["/v1/capacity/reconcile", "/v1/capacity/stop"].includes(url.pathname)) {
      const provider = capacity.provider(request.headers.authorization);
      if (!provider) return unauthorized(response);
      if (request.headers["x-dim-generation-id"] !== generation) return send(response, 409, { error: "capacity generation is stale" });
      const body = await read(request);
      return send(response, 200, url.pathname.endsWith("/stop") ? capacity.authorizeStop(provider, body) : capacity.reconcile(provider, body));
    }
    const taskRoute = /^\/v1\/tasks(?:\/([0-9a-f-]{36})\/(exchange|cancel|complete))?$/.exec(url.pathname);
    if (taskRoute !== null) {
      const credential = config.credentials.tasks;
      if (credential === undefined || !basic(request, credential.username, credential.password)) return unauthorized(response);
      if (request.headers["x-dim-generation-id"] !== generation) return send(response, 409, { error: "task issuer generation is stale" });
      const id = taskRoute[1], action = taskRoute[2];
      if (id === undefined && request.method === "POST") {
        const job = tasks.submit(await read(request));
        return send(response, 200, { executionId: job.id, generationId: generation });
      }
      if (id !== undefined && action === "exchange" && request.method === "GET") return send(response, 200, tasks.poll(id));
      if (id !== undefined && request.method === "POST") {
        const body = await read(request);
        if (action === "exchange") tasks.reply(id, body);
        else if (action === "cancel") { z.object({}).strict().parse(body); tasks.cancel(id); }
        else if (action === "complete") { z.object({}).strict().parse(body); tasks.release(id); }
        else return send(response, 404, {});
        return send(response, 200, { accepted: true });
      }
      return send(response, 404, {});
    }
    if (request.method === "POST" && url.pathname === "/v1/jobs") {
      if (config.credentials.webhook === undefined) return send(response, 404, {});
      if (!basic(request, config.credentials.webhook.username, config.credentials.webhook.password)) return unauthorized(response);
      const body = z.object({ generationId: z.literal(generation), event: executionEventSchema }).strict().parse(await read(request));
      const execution = store.enqueue(body.event);
      return send(response, 202, { executionId: execution.id, eventId: execution.event.eventId, generationId: generation });
    }
    const operatorRoute = /^\/v1\/operator\/(workers(?:\/enroll|\/([a-z0-9][a-z0-9._-]{0,127})\/export)?|jobs\/([0-9a-f-]{36})\/(cancel|retry))$/.exec(url.pathname);
    if (operatorRoute !== null) {
      if (!basic(request, config.credentials.operator.username, config.credentials.operator.password)) return unauthorized(response);
      if (request.headers["x-dim-generation-id"] !== generation) return send(response, 409, { error: "Execution operator generation is stale" });
      if (request.method === "POST" && operatorRoute[1] === "workers/enroll") return send(response, 200, registry.enroll(await read(request)));
      if (request.method === "POST" && operatorRoute[2] !== undefined) {
        z.object({}).strict().parse(await read(request)); return send(response, 200, registry.export(operatorRoute[2]));
      }
      if (request.method === "GET" && operatorRoute[1] === "workers") {
        const occupied = store.occupiedSlots();
        return send(response, 200, workers().map((worker) => ({ id: worker.id, observedConnected: registry.observed(worker.id),
          ...(registry.lastSeenAt(worker.id) === undefined ? {} : { lastSeenAt: registry.lastSeenAt(worker.id) }), slots: worker.slots.map((slot) => {
           const job = occupied.find((job) => job.workerId === worker.id && job.slotId === slot.id);
           return { id: slot.id, executionKind: slot.kind, state: job === undefined ? "idle" : job.phase === "recovering" ? "cleanup-required" : "busy",
             available: registry.observed(worker.id) && capacity.available(worker.id) && job === undefined,
             ...(job === undefined ? {} : { job: isTaskExecution(job) ? taskSummary(job) : store.executionSummary(job), leaseExpiresAt: job.leaseExpiresAt }) };
         }) })));
      }
      const id = operatorRoute[3], action = operatorRoute[4];
      if (request.method !== "POST" || id === undefined || action === undefined) return send(response, 404, {});
      if (action === "cancel") {
        z.object({}).strict().parse(await read(request));
        admission.cancel(id);
        const job = store.get(id);
        return send(response, 200, summary(store, isTaskExecution(job) ? tasks.cancel(id) : store.cancel(id)));
      }
      const body = z.object({ requestId: z.string().uuid() }).strict().parse(await read(request));
      if (isTaskExecution(store.get(id))) throw new ExecutionConflictError("interactive tasks require a fresh issuer session");
      return send(response, 200, summary(store, store.retry(id, body.requestId)));
    }
    const eventQuery = /^\/v1\/jobs\/by-event\/([^/]{1,300})$/.exec(url.pathname);
    const artifactQuery = /^\/v1\/jobs\/([0-9a-f-]{36})\/artifacts(?:\/([0-9a-f]{64}))?$/.exec(url.pathname);
    if (request.method === "GET" && (eventQuery || artifactQuery)) {
      if (config.credentials.query === undefined || !basic(request, config.credentials.query.username, config.credentials.query.password)) return unauthorized(response);
      if (request.headers["x-dim-generation-id"] !== generation) return send(response, 409, { error: "CI query generation is stale" });
      if (eventQuery) return send(response, 200, { jobs: store.byEvent(executionEventSchema.unwrap().shape.eventId.parse(decodeURIComponent(eventQuery[1]!))).map(job => detail(job)) });
      const id = artifactQuery![1]!, job = store.find(id);
      if (!job || isTaskExecution(job) || job.generationId !== generation || job.grant === undefined) return send(response, 404, {});
      const manifest = await artifacts.manifest(id);
      if (!manifest || manifest.descriptorDigest !== job.grant.descriptorDigest) return send(response, 404, {});
      if (!artifactQuery![2]) return send(response, 200, manifest);
      const bytes = await artifacts.bytes(id, artifactQuery![2]!);
      if (bytes === undefined) return send(response, 404, {});
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "Content-Length": bytes.length }); response.end(bytes); return;
    }
    const query = /^\/v1\/jobs(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
    if (request.method === "GET" && query) {
      if (config.credentials.query === undefined) return send(response, 404, {});
      if (!basic(request, config.credentials.query.username, config.credentials.query.password)) return unauthorized(response);
      if (request.headers["x-dim-generation-id"] !== generation) return send(response, 409, { error: "CI query generation is stale" });
      if (query[1] === undefined) return send(response, 200, store.recentSummaries());
      const job = store.find(query[1]);
      if (!job || isTaskExecution(job)) return send(response, 404, { error: "CI execution was not found" });
      return send(response, 200, detail(job));
    }
    const registration = registry.authenticateAuthorization(request.headers.authorization);
    const worker = registration === undefined ? undefined : workers().find((candidate) => candidate.id === registration.workerId);
    if (worker === undefined) return unauthorized(response);
    if (request.headers["x-dim-generation-id"] !== generation) return send(response, 409, { error: "Execution worker generation is stale" });
    registry.observe(worker.id);
    if (request.method === "GET" && url.pathname === "/v1/worker") {
      return send(response, 200, { generationId: generation, workerId: worker.id, slots: worker.slots });
    }
    if (request.method === "POST" && url.pathname === "/v1/claims") {
      const body = claimRequest.parse(await read(request));
      const slot = worker.slots.find((slot) => slot.id === body.slotId);
      if (slot === undefined) return send(response, 404, {});
      let assignment = store.reserve(worker.id, slot, body.requestId, () => capacity.allowsClaim(worker.id, slot.id, body.requestId));
      if (assignment === undefined) return send(response, 204);
      if (assignment.phase !== "assigned" || assignment.grant !== undefined) return send(response, 200, assignment);
      try {
        if (isTaskExecution(assignment)) {
          tasks.assertCurrent(assignment.id);
          const profile = taskProfileSchema.parse(assignment.profile);
          assignment = store.attachGrant(assignment.id, taskGrantSchema.parse({ executionId: assignment.id, generationId: generation,
            workerId: assignment.workerId, slotId: assignment.slotId, event: assignment.event, profile,
            descriptorDigest: taskDescriptorDigest(assignment.event, profile) }));
        } else {
          if (source === undefined) throw new StaleExecutionSourceError();
          assignment = await admission.authorize(assignment, source, response);
        }
      }
      catch (error) {
        if (error instanceof StaleExecutionSourceError) return send(response, 204);
        throw error;
      }
      return send(response, 200, assignment);
    }
    const match = /^\/v1\/executions\/([0-9a-f-]{36})\/(renew|candidate|result|recover|exchange|artifacts|artifacts-finalize)$/.exec(url.pathname);
    if (request.method !== "POST" || match === null) return send(response, 404, {});
    const id = match[1]!, action = match[2]!;
    const raw = await read(request);
    const body = ownership.passthrough().parse(raw);
    const assignment = store.owned(id, worker.id, body.slotId, body.leaseToken);
    if (action === "artifacts" || action === "artifacts-finalize") {
      if (isTaskExecution(assignment) || assignment.grant === undefined || assignment.generationId !== generation
        || assignment.cancelRequestedAt !== undefined || !["assigned", "running"].includes(assignment.phase)
        || (assignment.leaseExpiresAt ?? 0) <= store.now()) throw new ExecutionConflictError("artifact lease is no longer current");
      const upload = ownership.extend({ artifact: z.unknown() }).strict().parse(raw);
      if (!upload.artifact || typeof upload.artifact !== "object" || Reflect.get(upload.artifact, "descriptorDigest") !== assignment.grant.descriptorDigest) throw new ExecutionConflictError("artifact descriptor mismatch");
      const authorize = () => {
        const current = store.owned(id, worker.id, body.slotId, body.leaseToken);
        if (current.generationId !== generation || current.cancelRequestedAt !== undefined || !["assigned", "running"].includes(current.phase)
          || (current.leaseExpiresAt ?? 0) <= store.now()) throw new ExecutionConflictError("artifact lease is no longer current");
      };
      if (action === "artifacts") await artifacts.chunk(id, upload.artifact, authorize);
      else await artifacts.finalize(id, executionArtifactManifestSchema.parse(upload.artifact), authorize);
      return send(response, 200, { accepted: true });
    }
    if (action === "renew") {
      ownership.strict().parse(raw);
      const renewed = store.renew(id, worker.id, body.slotId, body.leaseToken);
      return send(response, 200, { expiresAt: renewed.leaseExpiresAt, leaseMilliseconds: config.claimLeaseMilliseconds });
    }
    if (action === "exchange") {
      if (!isTaskExecution(assignment)) return send(response, 404, {});
      const exchange = ownership.extend({ operation: z.string(), input: z.unknown() }).strict().parse(raw);
      const value = await tasks.exchange(id, worker.id, body.slotId, body.leaseToken, { operation: exchange.operation, input: exchange.input });
      return send(response, 200, { value });
    }
    if (action === "candidate") {
      if (isTaskExecution(assignment) || source === undefined) return send(response, 404, {});
      ownership.strict().parse(raw);
      return send(response, 200, await admission.candidate(assignment, source, response));
    }
    if (action === "recover") {
      ownership.extend({ cleanupComplete: z.literal(true) }).strict().parse(raw);
      store.recover(id, worker.id, body.slotId, body.leaseToken);
      return send(response, 200, { accepted: true });
    }
    const resultBody = ownership.extend({ result: z.unknown() }).strict().parse(raw);
    const finished = store.finish(id, worker.id, body.slotId, body.leaseToken, resultBody.result as never);
    if (isTaskExecution(finished)) {
      const current = tasks.hasSession(id) && assignment.generationId === generation && assignment.cancelRequestedAt === undefined
        && ["assigned", "running"].includes(assignment.phase) && (assignment.leaseExpiresAt ?? 0) > store.now();
      tasks.finish(id);
      if (assignment.result === undefined) store.published(id, current ? "accepted" : "stale");
    }
    send(response, 200, { accepted: true });
  }
  function detail(job: ReturnType<ExecutionStore["get"]>) {
    return { job: summary(store, job), ...(job.grant === undefined ? {} : { descriptorDigest: job.grant.descriptorDigest }), ...(job.result === undefined ? {} : { result: job.result }) };
  }
  async function publishResults(): Promise<void> {
    while (!shutdown.signal.aborted) {
      for (const job of store.pendingResults()) {
        if (shutdown.signal.aborted) return;
        try {
          if (isTaskExecution(job)) { store.published(job.id, "stale"); continue; }
          if (source === undefined || job.grant === undefined || job.result === undefined) throw new Error("finished execution lacks evidence");
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
function unauthorized(response: ServerResponse): void { response.setHeader("WWW-Authenticate", 'Basic realm="DIM execution"'); send(response, 401, {}); }
function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}
function taskSummary(job: import("@slop-lab/dim-contracts-execution").TaskExecution) {
  return { id: job.id, taskType: job.event.taskType, executionKind: job.event.executionKind, phase: job.phase,
    generationId: job.generationId, createdAt: job.createdAt, publication: job.publication };
}
function summary(store: ExecutionStore, job: import("./store.js").ScheduledExecution) {
  return isTaskExecution(job) ? taskSummary(job) : store.executionSummary(job);
}
async function read(request: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 1_500_000) throw new Error("Execution request exceeds bound"); chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ExecutionConflictError("Execution request is not JSON"); }
}
