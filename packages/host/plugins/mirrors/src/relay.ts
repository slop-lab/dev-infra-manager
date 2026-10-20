import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { parseEndpoints, type CacheEndpoints } from "./cache-routing.js";
import type { MirrorAdapterModule } from "./adapter.js";
import { loadMirrorAdapters } from "./registry.js";
import { WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import type { Socket } from "node:net";
export interface MirrorRelayConfig {
  workspaceStateRoot: string; workspaceName: string; workspaceId: string;
  listen: string; endpoints: CacheEndpoints;
  controlToken: string; configurationId: string;
  adapterModules?: readonly MirrorAdapterModule[];
}
export async function createMirrorRelay(config: MirrorRelayConfig) {
  const store = new WorkspaceStore(config.workspaceStateRoot), sockets = new Set<Socket>();
  let inflight = 0, closing = false;
  let didClose: () => void = () => {};
  const closed = new Promise<void>((resolve) => { didClose = resolve; });
  const adapters = await loadMirrorAdapters(config.adapterModules);
  config.endpoints = parseEndpoints(config.endpoints, adapters);
  const kinds = Object.keys(config.endpoints);
  const servers = kinds.map(create);
  const control = createServer((request, response) => {
    if (!authorized(request)) { response.writeHead(403); response.end(); return; }
    if (request.method === "GET" && request.url === "/__dim/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ workspaceId: config.workspaceId, configurationId: config.configurationId }));
    } else if (request.method === "POST" && request.url === "/__dim/close") {
      response.writeHead(200); response.end(); setImmediate(() => { void close(); });
    } else { response.writeHead(404); response.end(); }
  });
  control.maxConnections = 4; control.headersTimeout = 10_000; control.requestTimeout = 10_000;
  control.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const timer = setInterval(() => { void current().then((state) => { if (!state.owned) void close(); else if (!state.active) for (const socket of sockets) socket.destroy(); }); }, 500);
  async function current() {
    try { const record = await store.read(config.workspaceName); return { owned: record.id === config.workspaceId, active: record.id === config.workspaceId && record.phase === "running" && record.initialized }; }
    catch { return { owned: false, active: false }; }
  }
  async function close() {
    if (closing) return; closing = true; clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    await Promise.all([...servers, control].map((server) => server.listening ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve()));
    didClose();
  }
  try {
    if (!(await current()).active) throw new Error("mirror workspace identity is not current");
    for (const server of [...servers, control]) await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, config.listen, resolve); });
    const ports = servers.map((server) => { const address = server.address(); if (!address || typeof address === "string") throw new Error("mirror relay listener unavailable"); return address.port; });
    const controlAddress = control.address();
    if (!controlAddress || typeof controlAddress === "string") throw new Error("mirror control listener unavailable");
    return { controlPort: controlAddress.port, ports: Object.fromEntries(kinds.map((kind, index) => [kind, ports[index]!])) as Record<string, number>, close, closed,
      updateTargets(next: Pick<MirrorRelayConfig, "endpoints" | "configurationId">) {
        const endpoints = parseEndpoints(next.endpoints, adapters);
        if (JSON.stringify(Object.keys(endpoints).sort()) !== JSON.stringify([...kinds].sort())) throw new Error("mirror endpoint kinds changed");
        config.endpoints = endpoints; config.configurationId = next.configurationId;
      } };

  } catch (error) { await close(); throw error; }
  function create(kind: string) {
    const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
      void handle(kind, request, response).catch(() => { if (response.headersSent) response.destroy(); else { response.writeHead(502); response.end(); } });
    });
    server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1_000; server.maxConnections = 64;
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    server.on("upgrade", (_request, socket) => socket.destroy());
    server.on("connect", (_request, socket) => socket.destroy());
    return server;
  }
  async function handle(kind: string, request: IncomingMessage, response: ServerResponse) {
    const state = await current();
    if (!state.active) { response.writeHead(state.owned ? 503 : 410); response.end(); if (!state.owned) void close(); return; }
    if (!["GET", "HEAD"].includes(request.method ?? "") || request.headers["transfer-encoding"] !== undefined
      || request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") { request.resume(); response.writeHead(405); response.end(); return; }
    const endpoint = config.endpoints[kind]!;
    const adapter = adapters.get(kind)!;
    const path = request.url ?? "";
    const target = adapter.target(path, endpoint);
    if (!target) { response.writeHead(403); response.end(); return; }
    if (inflight >= 32) { response.writeHead(429); response.end(); return; }
    inflight++;
    const upstream = new URL(endpoint), clientOrigin = `http://${config.listen}:${serverPort(kind)}`;
    const headers: Record<string, string> = { host: upstream.host };
    for (const name of ["accept", "range", "if-none-match", "if-modified-since", "user-agent"]) {
      const value = request.headers[name]; if (typeof value === "string") headers[name] = value;
    }
    // Identity encoding keeps bounded metadata rewriting independent of compression.
    headers["accept-encoding"] = "identity";
    const transport = upstream.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = transport({ hostname: upstream.hostname.replace(/^\[|\]$/g, ""), port: upstream.port || undefined, method: request.method,
      path: adapter.requestPath?.(target) ?? `${target.pathname}${target.search}`, headers }, (incoming) => {
      const resultHeaders: Record<string, string | number | string[]> = {};
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control", ...(adapter.responseHeaders ?? [])]) {
        const value = incoming.headers[name]; if (value !== undefined) resultHeaders[name] = value;
      }
      const type = String(incoming.headers["content-type"] ?? "");
      if (adapter.metadata?.accepts(type) && request.method !== "HEAD" && incoming.statusCode === 200) {
        const chunks: Buffer[] = []; let length = 0;
        incoming.on("data", (chunk: Buffer) => { length += chunk.length;
          if (length > 16 * 1024 * 1024) incoming.destroy(new Error("package metadata exceeds 16 MiB")); else chunks.push(chunk);
        });
        incoming.on("end", () => {
          try {
            const body = adapter.metadata!.rewrite(Buffer.concat(chunks).toString("utf8"), { upstream: target, endpoint, clientOrigin });
            delete resultHeaders["etag"]; delete resultHeaders["content-length"];
            response.writeHead(200, { ...resultHeaders, "content-length": Buffer.byteLength(body) }); response.end(body);
          } catch { response.writeHead(502); response.end("invalid package cache metadata"); }
        });
        incoming.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      } else {
        response.writeHead(incoming.statusCode ?? 502, resultHeaders); incoming.on("error", () => response.destroy()); incoming.pipe(response);
      }
    });
    const headersDeadline = setTimeout(() => outgoing.destroy(new Error("cache response headers timed out")), 10_000);
    outgoing.once("response", () => clearTimeout(headersDeadline)); outgoing.once("close", () => clearTimeout(headersDeadline));
    let settled = false;
    const done = () => { if (!settled) { settled = true; inflight--; } };
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error("cache transfer became idle")));
    outgoing.on("error", () => { done(); if (response.headersSent) response.destroy(); else { response.writeHead(502); response.end(); } });
    response.on("close", () => { done(); if (!response.writableEnded) outgoing.destroy(); });
    response.on("finish", done); request.on("aborted", () => outgoing.destroy()); outgoing.end();
  }
  function serverPort(kind: string): number {
    const address = servers[kinds.indexOf(kind)]!.address();
    if (!address || typeof address === "string") throw new Error("cache listener unavailable");
    return address.port;
  }
  function authorized(request: IncomingMessage) {
    const input = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${config.controlToken}`);
    return input.length === expected.length && timingSafeEqual(input, expected);
  }
}
