import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, open } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WorkspaceStore } from "@slop-lab/dim-core/workspace";
import { tryAcquireKernelGuard } from "@slop-lab/dim-core";
import { object, privateFile, type RouterConfig } from "./config.js";
import { AdmissionError, hash, RouterLedger, type WorkspaceGrant } from "./ledger.js";
import { UsageObserver } from "./usage.js";

class RequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export async function createRouter(config: RouterConfig) {
  const ledger = new RouterLedger(config.stateDirectory);
  const guard = await tryAcquireKernelGuard(join(config.stateDirectory, "service.guard"));
  if (guard === undefined) { ledger.close(); throw new Error("LLM router is already running for this state directory"); }
  ledger.recoverInterrupted();
  const workspaces = new WorkspaceStore(config.workspaceStateRoot);
  const active = new Set<Promise<void>>(), cancellation = new AbortController();
  const server = createServer((request, response) => {
    const operation = handle(request, response).catch((error: unknown) => {
      if (response.headersSent) response.destroy();
      else send(response, error instanceof RequestError ? error.status : error instanceof AdmissionError ? 429 : 503,
        { error: { type: "dim_llm_router", message: error instanceof RequestError || error instanceof AdmissionError ? error.message : "router operation unavailable" } });
    });
    active.add(operation); void operation.finally(() => active.delete(operation));
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1_000;
  return { server, ledger, async close() {
    cancellation.abort(); server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled(active); ledger.close(); await guard.release();
  } };
  async function current(grant: WorkspaceGrant): Promise<boolean> {
    try { const workspace = await workspaces.read(grant.workspaceName);
      return workspace.id === grant.workspaceId && workspace.initialized && workspace.phase === "running";
    } catch { return false; }
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://dim-llm-router");
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? "")?.[1];
    const grant = token === undefined ? undefined : ledger.authenticate(token);
    if (grant === undefined || !await current(grant)) throw new RequestError(401, "workspace access is unavailable");
    const route = config.routes.find((route) => route.id === grant.routeId);
    if (route === undefined) throw new RequestError(403, "workspace route is unavailable");
    if (url.search !== "") throw new RequestError(404, "unsupported endpoint");
    if (request.method === "GET" && url.pathname === "/v1/usage") return send(response, 200, ledger.usage(grant.workspaceId));
    if (request.method === "GET" && url.pathname === "/v1/models") return send(response, 200, {
      object: "list", data: route.models.map((model) => ({ id: model.id, object: "model", owned_by: "dim-route" })) });
    const api = url.pathname === "/v1/responses" ? "responses" : url.pathname === "/v1/chat/completions" ? "chat" : undefined;
    if (request.method !== "POST" || api === undefined) throw new RequestError(404, "unsupported endpoint");
    const bytes = await body(request, config.limits.requestBytes);
    let payload: Record<string, unknown>;
    try { const value: unknown = JSON.parse(bytes.toString("utf8")); payload = object(value); }
    catch { throw new RequestError(400, "request must be a JSON object"); }
    const model = route.models.find((model) => model.id === payload.model && model.api === api);
    if (model === undefined) throw new RequestError(403, "model is not permitted by this workspace route");
    for (const name of ["previous_response_id", "conversation", "background", "api_key", "apiKey", "base_url", "account", "account_id", "route", "provider"]) {
      if (payload[name] !== undefined && payload[name] !== false && payload[name] !== null) throw new RequestError(400, `unsupported request field: ${name}`);
    }
    if (payload.stream !== undefined && typeof payload.stream !== "boolean") throw new RequestError(400, "stream must be boolean");
    const key = (await privateFile(route.keyFile, 16 * 1024)).trim();
    if (!key || /[\r\n]/.test(key)) throw new Error("invalid upstream access key");
    const policy = hash(JSON.stringify({ route: { id: route.id, endpoint: route.endpoint, models: route.models }, limits: config.limits }));
    const id = ledger.reserve(grant, model.id, policy, bytes.length, config.limits);
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, cancellation.signal, AbortSignal.timeout(config.limits.deadlineMilliseconds)]);
    const cancel = () => { if (!response.writableEnded) stop.abort(); };
    request.once("aborted", cancel); response.once("close", cancel);
    let checking = false;
    const revoked = setInterval(() => {
      if (checking) return; checking = true;
      void current(grant).then((valid) => { if (!valid || ledger.authenticate(token!) === undefined) stop.abort(); })
        .catch(() => stop.abort()).finally(() => { checking = false; });
    }, 1_000);
    revoked.unref();
    const directory = join(config.stateDirectory, "captures", id);
    let capture: Awaited<ReturnType<typeof open>> | undefined;
    const observer = new UsageObserver(payload.stream === true), responseHash = createHash("sha256");
    let responseBytes = 0, received = false;
    let finalResponseHash: string | undefined;
    const capturedHash = () => finalResponseHash ??= responseHash.digest("hex");
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const input = await open(join(directory, "request.json"), "wx", 0o600);
      try { await input.writeFile(bytes); await input.sync(); } finally { await input.close(); }
      capture = await open(join(directory, "response.body"), "wx", 0o600);
      signal.throwIfAborted();
      const upstream = await fetch(`${route.endpoint}${url.pathname}`, { method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: payload.stream === true ? "text/event-stream" : "application/json" },
        body: bytes });
      if (upstream.status >= 400) { await upstream.body?.cancel(); throw new RequestError(502, "upstream rejected the request"); }
      const contentType = upstream.headers.get("content-type") ?? "";
      if (upstream.status !== 200 || !(contentType.startsWith("application/json") || contentType.startsWith("text/event-stream"))) {
        await upstream.body?.cancel(); throw new RequestError(502, "upstream returned an unsupported response");
      }
      response.writeHead(200, { "content-type": contentType, "cache-control": "no-store", "x-dim-request-id": id });
      if (upstream.body === null) throw new Error("upstream body is missing");
      for await (const chunk of upstream.body) {
        received = true; responseBytes += chunk.byteLength;
        if (responseBytes > config.limits.responseBytes) throw new Error("upstream response exceeds configured bound");
        ledger.append(id, grant.workspaceId, chunk.byteLength, config.limits.captureBytesPerWorkspace);
        await capture.write(chunk); await capture.sync(); responseHash.update(chunk); observer.push(chunk);
        if (!response.write(chunk)) await once(response, "drain", { signal });
      }
      observer.finish();
      if (!observer.completed) throw new Error("upstream response ended without a completion marker");
      ledger.finish(id, { outcome: observer.failed ? "failed" : "completed", captureComplete: true, requestHash: hash(bytes), responseHash: capturedHash(),
        ...(observer.model === undefined ? {} : { observedModel: observer.model }), ...(observer.usage === undefined ? {} : { usage: observer.usage }) });
      response.end();
    } catch (error) {
      const interrupted = signal.aborted;
      stop.abort();
      ledger.finish(id, { outcome: interrupted && !(error instanceof RequestError) ? "cancelled" : "failed", captureComplete: false,
        requestHash: hash(bytes), ...(received ? { responseHash: capturedHash() } : {}),
        ...(observer.usage === undefined ? {} : { usage: observer.usage }), errorCode: error instanceof RequestError ? "upstream-rejected" : "request-incomplete" });
      throw error;
    } finally {
      clearInterval(revoked); request.removeListener("aborted", cancel); response.removeListener("close", cancel);
      await capture?.close();
    }
  }
}
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > maximum) throw new RequestError(413, "request body exceeds configured bound"); chunks.push(bytes); }
  return Buffer.concat(chunks);
}
