import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WorkspaceStore } from "@slop-lab/dim-core/workspace";
import { tryAcquireKernelGuard } from "@slop-lab/dim-core";
import { object, privateFile, type RouterConfig } from "./config.js";
import { AdmissionError, hash, RouterLedger, type WorkspaceGrant } from "./ledger.js";
import { ArchiveError, ExchangeArchive, captureBody, captureManifest } from "./archive.js";
import { UsageObserver } from "./usage.js";

class RequestError extends Error { constructor(readonly status: number, message: string, readonly category = "invalid_request") { super(message); } }
export async function createRouter(config: RouterConfig) {
  const ledger = new RouterLedger(config.stateDirectory);
  const guard = await tryAcquireKernelGuard(join(config.stateDirectory, "service.guard"));
  if (guard === undefined) { ledger.close(); throw new Error("LLM router is already running for this state directory"); }
  ledger.recoverInterrupted();
  const workspaces = new WorkspaceStore(config.workspaceStateRoot), active = new Set<Promise<void>>(), cancellation = new AbortController();
  let readers = 0;
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const operation = handle(request, response).catch((error: unknown) => {
      if (response.headersSent) response.destroy();
      else {
        const known = error instanceof RequestError || error instanceof AdmissionError;
        const requestId = response.getHeader("x-dim-request-id");
        const indeterminate = typeof requestId === "string" && ledger.request(requestId).execution === "outcome_unknown";
        send(response, error instanceof RequestError ? error.status : error instanceof AdmissionError ? error.category === "authorization_failed" ? 403 : error.category === "cancellation_requested" ? 409 : error.category === "payload_too_large" ? 413 : error.category === "recording_failed" || error.category === "admissions_paused" ? 503 : 429 : 503,
          { error: { type: "dim_llm_router", category: indeterminate ? "indeterminate_upstream_outcome" : known ? error.category : error instanceof ArchiveError ? "recording_failed" : "service_unavailable", message: known ? error.message : "router operation unavailable",
            requestId: response.getHeader("x-dim-request-id") ?? null, retryable: !indeterminate && (error instanceof AdmissionError ? ["local_capacity_exhausted", "local_quota_exhausted"].includes(error.category) : !known), scope: "service/project policy", retryAt: null } });
      }
    });
    active.add(operation); void operation.finally(() => active.delete(operation));
  });
  server.maxConnections = Math.min(256, Math.max(8, config.limits.concurrent * 2));
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1_000;
  return { server, ledger, close() { return closing ??= (async () => {
    cancellation.abort(); server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled(active); ledger.close(); await guard.release();
  })(); } };
  async function current(grant: WorkspaceGrant): Promise<boolean> {
    try { const workspace = await workspaces.read(grant.workspaceName); return workspace.id === grant.workspaceId && workspace.initialized && workspace.phase === "running"; }
    catch { return false; }
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://dim-llm-router");
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? "")?.[1];
    const grant = token === undefined ? undefined : ledger.authenticate(token);
    if (grant === undefined || !await current(grant)) throw new RequestError(401, "workspace principal is unavailable", "authentication_failed");
    if (request.headers["x-dim-project-id"] !== undefined && request.headers["x-dim-project-id"] !== grant.projectId) throw new RequestError(403, "principal cannot select another project", "authorization_failed");
    const route = config.routes.find((route) => route.id === grant.routeId), account = route && config.accounts.find((account) => account.id === route.accountId);
    if (!route || !account) throw new RequestError(403, "principal route is unavailable", "authorization_failed");
    if (url.search !== "") throw new RequestError(404, "unsupported endpoint");
    if (request.method === "GET" && url.pathname === "/v1/usage") return send(response, 200, ledger.usage(grant.projectId, config.limits));
    if (request.method === "GET" && url.pathname === "/v1/capabilities") return send(response, 200, { projectId: grant.projectId, principalId: grant.principalId,
      backend: config.backend, routeId: route.id, accountId: account.id, accountAttribution: "operator exclusive-worker binding", models: route.models,
      streaming: true, maximumSseEventBytes: 1024 * 1024, toolCalls: "unchanged application protocol", multimodal: "unchanged inline/referenced fields; referenced bytes not fetched", statefulContinuation: false,
      strictTokenBounds: false, captureBoundary: "client application bodies", policy: ledger.project(grant.projectId).policy, serviceLimits: config.limits, scheduling: "no queue; capacity rejection is immediate" });
    if (request.method === "GET" && url.pathname === "/v1/models") return send(response, 200, { object: "list", data: route.models.map((model) => ({ id: model.id, object: "model", owned_by: "dim-route" })) });
    const match = /^\/v1\/requests\/([a-f0-9-]{36})(?:\/(capture|request|response|cancel))?$/.exec(url.pathname);
    if (match?.[1]) {
      const id = match[1], operation = match[2];
      try { ledger.request(id, grant.projectId); } catch { throw new RequestError(404, "request was not found"); }
      if (request.method === "POST" && operation === "cancel") {
        const content = (await body(request, 1024)).toString().trim();
        if (content !== "" && content !== "{}") throw new RequestError(400, "cancel accepts an empty body or JSON object");
        ledger.cancel(id, grant.principalId); return send(response, 202, { requestId: id, cancellationRequested: true, upstreamTerminationConfirmed: false }); }
      if (request.method !== "GET" || operation === "cancel") throw new RequestError(404, "unsupported endpoint");
      ledger.audit(grant.principalId, "capture.read", id);
      if (operation === undefined || operation === "capture") return send(response, 200, captureManifest(ledger, id, grant.projectId));
      if (readers >= 2) throw new RequestError(429, "archive read capacity is exhausted", "local_capacity_exhausted");
      readers++;
      try {
        let bytes: Buffer;
        try { bytes = await captureBody(ledger, id, operation === "request" ? "request" : "response", grant.projectId); }
        catch { throw new RequestError(410, "capture is unavailable, expired, incomplete or failed integrity validation", "recording_unavailable"); }
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="exchange.body"', "x-content-type-options": "nosniff", "cache-control": "no-store" });
        await new Promise<void>((resolve, reject) => {
          const done = () => { cleanup(); resolve(); }, failed = (error: Error) => { cleanup(); reject(error); };
          const cleanup = () => { response.off("finish", done); response.off("close", done); response.off("error", failed); };
          response.once("finish", done); response.once("close", done); response.once("error", failed); response.end(bytes);
        }); return;
      } finally { readers--; }
    }
    const api = url.pathname === "/v1/responses" ? "responses" : url.pathname === "/v1/chat/completions" ? "chat" : undefined;
    if (request.method !== "POST" || api === undefined) throw new RequestError(404, "unsupported endpoint");
    const policy = ledger.project(grant.projectId).policy;
    const bytes = await body(request, Math.min(policy.limits.requestBytes, config.limits.requestBytes));
    let payload: Record<string, unknown>;
    try { const value: unknown = JSON.parse(bytes.toString("utf8")); payload = object(value); } catch { throw new RequestError(400, "request must be a JSON object"); }
    const model = route.models.find((model) => model.id === payload.model && model.api === api);
    if (!model) throw new RequestError(403, "model is not permitted by this principal route", "authorization_failed");
    for (const name of ["previous_response_id", "conversation", "background", "api_key", "apiKey", "base_url", "account", "account_id", "route", "provider", "project_id"]) {
      if (payload[name] !== undefined && payload[name] !== false && payload[name] !== null) throw new RequestError(400, `unsupported request field: ${name}`, "unsupported_capability");
    }
    if (payload.stream !== undefined && typeof payload.stream !== "boolean") throw new RequestError(400, "stream must be boolean");
    const key = (await privateFile(account.keyFile, 16 * 1024)).trim();
    if (!key || /[\r\n]/.test(key)) throw new Error("invalid upstream access key");
    const admission = ledger.reserve(grant, model.id, hash(JSON.stringify({ route, account: { id: account.id, reference: account.reference, endpoint: account.endpoint }, limits: config.limits })), bytes.length, config.limits, { ...route, backend: config.backend });
    const { id } = admission, limits = admission.policy.limits;
    response.setHeader("x-dim-request-id", id);
    const stop = new AbortController(), deadline = AbortSignal.timeout(Math.min(limits.deadlineMilliseconds, config.limits.deadlineMilliseconds));
    const signal = AbortSignal.any([stop.signal, cancellation.signal, deadline]);
    let clientDisconnected = false;
    const cancel = () => { if (!response.writableEnded) { clientDisconnected = true; stop.abort(); } };
    request.once("aborted", cancel); response.once("close", cancel);
    let checking = false;
    const revoked = setInterval(() => {
      if (checking) return; checking = true;
      void current(grant).then((valid) => { if (!valid || !ledger.authenticate(token!) || ledger.cancelled(id)) stop.abort(); }).catch(() => stop.abort()).finally(() => { checking = false; });
    }, 250); revoked.unref();
    const archive = new ExchangeArchive(ledger, id, grant.projectId, admission.policy), observer = new UsageObserver(payload.stream === true);
    let responseBytes = 0, upstreamRejected = false;
    try {
      await archive.begin(bytes); signal.throwIfAborted(); ledger.dispatch(id);
      const upstream = await fetch(`${account.endpoint}${url.pathname}`, { method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: payload.stream === true ? "text/event-stream" : "application/json" }, body: bytes });
      const contentType = upstream.headers.get("content-type") ?? "";
      upstreamRejected = upstream.status >= 400;
      if (!(contentType.startsWith("application/json") || contentType.startsWith("text/event-stream")) || upstream.body === null) {
        await upstream.body?.cancel(); throw new RequestError(502, "upstream returned an unsupported response", "unsupported_upstream_response");
      }
      ledger.response(id, upstream.status, contentType);
      response.writeHead(upstream.status, { "content-type": contentType, "cache-control": "no-store", ...(upstreamRejected ? { "x-dim-error-category": upstream.status === 429 ? "upstream_rate_limited" : upstream.status === 401 || upstream.status === 403 ? "account_unavailable" : "upstream_rejected" } : {}) });
      for await (const chunk of upstream.body) {
        responseBytes += chunk.byteLength;
        if (responseBytes > Math.min(limits.responseBytes, config.limits.responseBytes)) throw new Error("upstream response exceeds configured bound");
        await archive.append(chunk); observer.push(chunk);
        if (!response.write(chunk)) await once(response, "drain", { signal });
      }
      observer.finish();
      if (!upstreamRejected && !observer.completed) throw new Error("upstream response ended without a completion marker");
      if (observer.model !== undefined && observer.model !== model.id) throw new RequestError(502, "observed upstream model differs from the reviewed model", "upstream_policy_violation");
      const recorded = archive.result();
      ledger.finish(id, { outcome: upstreamRejected || observer.failed ? "failed" : "completed", captureComplete: recorded.complete, requestHash: hash(bytes), ...recorded,
        ...(observer.model === undefined ? {} : { observedModel: observer.model }), ...(observer.usage === undefined ? {} : { usage: observer.usage }), ...(observer.rawUsage === undefined ? {} : { rawUsage: observer.rawUsage }),
        ...(upstreamRejected ? { errorCode: "upstream-rejected" } : {}), delivery: "complete" });
      response.end();
    } catch (error) {
      const interrupted = signal.aborted; stop.abort(); const recorded = archive.result();
      ledger.finish(id, { outcome: interrupted && !(error instanceof RequestError) ? "cancelled" : "failed", captureComplete: recorded.complete && observer.completed, executionFinished: observer.completed, requestHash: hash(bytes),
        ...(recorded.responseHash === undefined ? {} : { responseHash: recorded.responseHash }), ...(observer.model === undefined ? {} : { observedModel: observer.model }),
        ...(observer.usage === undefined ? {} : { usage: observer.usage }), ...(observer.rawUsage === undefined ? {} : { rawUsage: observer.rawUsage }), delivery: clientDisconnected ? "client_disconnected" : responseBytes ? "partial" : "not_started",
        errorCode: deadline.aborted ? "deadline_expired" : ledger.cancelled(id) ? "cancellation_requested" : error instanceof RequestError || error instanceof AdmissionError ? error.category : error instanceof ArchiveError ? "recording_failed" : "request-incomplete" });
      throw error;
    } finally { clearInterval(revoked); request.removeListener("aborted", cancel); response.removeListener("close", cancel); await archive.close(); }
  }
}
function send(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
async function body(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maximum) throw new RequestError(413, "request body exceeds configured bound"); chunks.push(bytes); } return Buffer.concat(chunks);
}
