import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { WorkspaceStore } from "@slop-lab/dim-core/workspace";
import type { Socket } from "node:net";
export interface MirrorRelayConfig {
  workspaceStateRoot: string; workspaceName: string; workspaceId: string;
  listen: string; registry: { host: string; port: number }; apt: { host: string; port: number };
  controlToken: string; configurationId: string;
}
const aptHosts = new Set(["deb.debian.org", "security.debian.org", "archive.ubuntu.com", "security.ubuntu.com", "ports.ubuntu.com"]);
export function aptTarget(path: string): URL | undefined {
  try {
    const target = new URL(path);
    if (target.protocol !== "http:" || target.username || target.password || target.port !== "" || target.hash !== "" || !aptHosts.has(target.hostname)) return;
    return target;
  } catch { return; }
}
export async function createMirrorRelay(config: MirrorRelayConfig) {
  const store = new WorkspaceStore(config.workspaceStateRoot), sockets = new Set<Socket>();
  let inflight = 0, closing = false;
  let didClose: () => void = () => {};
  const closed = new Promise<void>((resolve) => { didClose = resolve; });
  const servers = [create("registry"), create("apt")];
  const timer = setInterval(() => { void current().then((state) => { if (!state.owned) void close(); else if (!state.active) for (const socket of sockets) socket.destroy(); }); }, 500);
  async function current() {
    try { const record = await store.read(config.workspaceName); return { owned: record.id === config.workspaceId, active: record.id === config.workspaceId && record.phase === "running" && record.initialized }; }
    catch { return { owned: false, active: false }; }
  }
  async function close() {
    if (closing) return; closing = true; clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => server.listening ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve()));
    didClose();
  }
  try {
    if (!(await current()).active) throw new Error("mirror workspace identity is not current");
    for (const server of servers) await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, config.listen, resolve); });
    const ports = servers.map((server) => { const address = server.address(); if (!address || typeof address === "string") throw new Error("mirror relay listener unavailable"); return address.port; });
    return { registryPort: ports[0]!, aptPort: ports[1]!, close, closed, updateTargets(next: Pick<MirrorRelayConfig, "registry" | "apt" | "configurationId">) { config.registry = next.registry; config.apt = next.apt; config.configurationId = next.configurationId; } };
  } catch (error) { await close(); throw error; }
  function create(kind: "registry" | "apt") {
    const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
      void handle(kind, request, response).catch(() => { if (response.headersSent) response.destroy(); else { response.writeHead(502); response.end(); } });
    });
    server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1_000; server.maxConnections = 64;
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    server.on("upgrade", (_request, socket) => socket.destroy());
    server.on("connect", (_request, socket) => socket.destroy());
    return server;
  }
  async function handle(kind: "registry" | "apt", request: IncomingMessage, response: ServerResponse) {
    const state = await current();
    if (!state.active) { response.writeHead(state.owned ? 503 : 410); response.end(); if (!state.owned) void close(); return; }
    if (kind === "registry" && request.url === "/__dim/health" && request.method === "GET" && authorized(request)) {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ workspaceId: config.workspaceId, configurationId: config.configurationId })); return;
    }
    if (kind === "registry" && request.url === "/__dim/close" && request.method === "POST" && authorized(request)) {
      response.writeHead(200); response.end(); setImmediate(() => { void close(); }); return;
    }
    if (!["GET", "HEAD"].includes(request.method ?? "") || request.headers["transfer-encoding"] !== undefined
      || request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") { request.resume(); response.writeHead(405); response.end(); return; }
    const target = kind === "registry" ? /^\/v2(?:\/|\?|$)/.test(request.url ?? "") ? request.url : undefined : aptTarget(request.url ?? "")?.href;
    if (!target) { response.writeHead(403); response.end(); return; }
    if (inflight >= 64) { response.writeHead(429); response.end(); return; }
    inflight++;
    const upstream = config[kind];
    const headers: Record<string, string> = { host: kind === "apt" ? new URL(target).host : `${upstream.host}:${upstream.port}` };
    for (const name of ["accept", "range", "if-none-match", "if-modified-since", "user-agent"]) {
      const value = request.headers[name]; if (typeof value === "string") headers[name] = value;
    }
    const outgoing = httpRequest({ hostname: upstream.host, port: upstream.port, method: request.method, path: target, headers }, (incoming) => {
      const resultHeaders: Record<string, string | number | string[]> = {};
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "docker-content-digest", "docker-distribution-api-version", "cache-control"]) {
        const value = incoming.headers[name]; if (value !== undefined) resultHeaders[name] = value;
      }
      response.writeHead(incoming.statusCode ?? 502, resultHeaders); incoming.on("error", () => response.destroy()); incoming.pipe(response);
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
  function authorized(request: IncomingMessage) {
    const input = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${config.controlToken}`);
    return input.length === expected.length && timingSafeEqual(input, expected);
  }
}
