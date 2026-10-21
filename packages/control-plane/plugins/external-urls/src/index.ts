import { timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { z } from "zod";

const listen = z.object({ host: z.string().min(1), port: z.number().int().min(0).max(65535) }).strict();
const origin = z.string().refine((value) => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash; } catch { return false; }
}, "must be an HTTP(S) origin without credentials, path or query");
const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const externalUrlIngressConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  domain: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,62}$/),
  publicListen: listen,
  managementListen: listen,
  hosts: z.array(z.object({ id: identifier, token: z.string().min(32).max(256), relayOrigin: origin }).strict()).min(1).max(256)
}).strict().superRefine((value, context) => {
  if (new Set(value.hosts.map(({ id }) => id)).size !== value.hosts.length) context.addIssue({ code: "custom", message: "duplicate host identity" });
  if (new Set(value.hosts.map(({ token }) => token)).size !== value.hosts.length) context.addIssue({ code: "custom", message: "each host requires its own token" });
});
export type ExternalUrlIngressConfiguration = z.infer<typeof externalUrlIngressConfigurationSchema>;
export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1, name: "external-urls",
  configure(raw) {
    const config = externalUrlIngressConfigurationSchema.parse(raw);
    return { start: ({ signal }) => startExternalUrlIngress(config, signal) };
  }
};

type Claim = { hostId: string; routeId: string; expires: number; flows: Set<() => void> };
const leaseMs = 35_000;
/** Route leases are intentionally ephemeral: a restart fails closed until hosts reconcile. */
export async function startExternalUrlIngress(input: ExternalUrlIngressConfiguration, signal: AbortSignal) {
  const config = externalUrlIngressConfigurationSchema.parse(input);
  signal.throwIfAborted();
  const claims = new Map<string, Claim>();
  const allSockets = new Set<Duplex>();
  const remove = (authority: string) => {
    const claim = claims.get(authority); claims.delete(authority);
    for (const destroy of claim?.flows ?? []) destroy();
  };
  const publicServer = http.createServer((request, response) => { void proxy(request, response).catch(() => response.destroy()); });
  publicServer.on("upgrade", (request, socket, head) => upgrade(request, socket, head));
  const managementServer = http.createServer((request, response) => { void manage(request, response).catch(() => send(response, 400, { error: "invalid ingress management request" })); });
  managementServer.requestTimeout = 5000; managementServer.headersTimeout = 5000;
  for (const server of [publicServer, managementServer]) server.on("connection", (socket) => { allSockets.add(socket); socket.once("close", () => allSockets.delete(socket)); });
  const expiry = setInterval(() => { for (const [authority, claim] of claims) if (claim.expires <= Date.now()) remove(authority); }, 1000);
  expiry.unref();
  let closed: Promise<void> | undefined;
  const close = () => closed ??= (async () => {
    clearInterval(expiry); signal.removeEventListener("abort", aborted);
    for (const authority of claims.keys()) remove(authority);
    for (const socket of allSockets) socket.destroy();
    await Promise.all([publicServer, managementServer].map(async (server) => {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }));
  })();
  const aborted = () => { void close().catch(() => {}); };
  try {
    await bind(publicServer, config.publicListen); await bind(managementServer, config.managementListen);
    signal.throwIfAborted(); signal.addEventListener("abort", aborted, { once: true });
  } catch (error) { await close(); throw error; }
  return { close, publicOrigin: address(publicServer, config.publicListen.host), managementOrigin: address(managementServer, config.managementListen.host) };

  async function manage(request: IncomingMessage, response: ServerResponse) {
    const host = config.hosts.find(({ id, token }) => request.headers["x-dim-host-id"] === id && equal(request.headers.authorization ?? "", `Bearer ${token}`));
    if (!host) { send(response, 401, { error: "unauthorized" }); return; }
    if (request.method === "GET" && request.url === "/v1/identity") { send(response, 200, { schemaVersion: 1, hostId: host.id, domain: config.domain }); return; }
    if (request.url !== "/v1/routes" || !["PUT", "DELETE"].includes(request.method ?? "")) { send(response, 404, { error: "not found" }); return; }
    if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json" || request.headers.origin !== undefined) { send(response, 403, { error: "JSON host request required" }); return; }
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 4096) throw new Error("request too large"); chunks.push(bytes); }
    const value = z.object({ routeId: z.string().min(1).max(1024), authorities: z.array(z.string().max(253)).min(1).max(2) }).strict().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (value.authorities.some((authority) => !validAuthority(authority, config.domain))) { send(response, 400, { error: "route is outside the configured wildcard domain" }); return; }
    for (const authority of value.authorities) {
      const current = claims.get(authority);
      if (current && current.expires <= Date.now()) remove(authority);
      const owner = claims.get(authority);
      if (owner && (owner.hostId !== host.id || owner.routeId !== value.routeId)) { send(response, 409, { error: "route belongs to a different host or workspace" }); return; }
    }
    for (const authority of value.authorities) {
      if (request.method === "DELETE") remove(authority);
      else {
        const current = claims.get(authority);
        if (current) current.expires = Date.now() + leaseMs;
        else claims.set(authority, { hostId: host.id, routeId: value.routeId, expires: Date.now() + leaseMs, flows: new Set() });
      }
    }
    send(response, 200, { accepted: true, leaseMs });
  }

  function select(request: IncomingMessage) {
    const authority = (request.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
    const claim = claims.get(authority);
    if (!claim || claim.expires <= Date.now()) { if (claim) remove(authority); return undefined; }
    const host = config.hosts.find(({ id }) => id === claim.hostId)!;
    return { claim, target: new URL(host.relayOrigin) };
  }
  async function proxy(request: IncomingMessage, response: ServerResponse) {
    const selected = select(request);
    if (!selected) { send(response, 404, { error: "external route not found" }); return; }
    const { claim, target } = selected;
    const upstream = (target.protocol === "https:" ? https : http).request({
      hostname: target.hostname, port: target.port || undefined, method: request.method, path: request.url ?? "/", headers: cleanHeaders(request.headers)
    });
    const destroy = () => { request.destroy(); response.destroy(); upstream.destroy(); };
    claim.flows.add(destroy);
    response.once("close", () => { claim.flows.delete(destroy); upstream.destroy(); });
    request.once("aborted", destroy); request.once("error", destroy);
    upstream.once("response", (received) => {
      received.once("error", destroy); response.writeHead(received.statusCode ?? 502, cleanHeaders(received.headers)); received.pipe(response);
    });
    upstream.once("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  }
  function upgrade(request: IncomingMessage, client: Duplex, head: Buffer) {
    const selected = select(request);
    if (!selected) { client.destroy(); return; }
    const { claim, target } = selected;
    const upstream = target.protocol === "https:" ? tls.connect({ port: Number(target.port || 443), host: target.hostname, servername: net.isIP(target.hostname) ? undefined : target.hostname }) : net.connect(Number(target.port || 80), target.hostname);
    const destroy = () => { claim.flows.delete(destroy); client.destroy(); upstream.destroy(); };
    claim.flows.add(destroy);
    upstream.once(target.protocol === "https:" ? "secureConnect" : "connect", () => {
      const headers = Object.entries(cleanHeaders(request.headers, true)).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).filter((item) => item !== undefined).map((item) => `${name}: ${item}`));
      upstream.write(`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head); client.pipe(upstream).pipe(client);
    });
    client.once("error", destroy); client.once("close", destroy); upstream.once("error", destroy); upstream.once("close", destroy);
  }
}
function validAuthority(value: string, domain: string) {
  const suffix = `.${domain}`;
  return value.endsWith(suffix) && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.slice(0, -suffix.length));
}
function equal(a: string, b: string) { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
function cleanHeaders(input: IncomingMessage["headers"], upgrade = false) {
  const headers = { ...input };
  const nominated = String(headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase());
  for (const name of [...nominated, "connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) delete headers[name];
  if (upgrade) { headers.connection = "Upgrade"; headers.upgrade = input.upgrade ?? "websocket"; }
  return headers;
}
function send(response: ServerResponse, status: number, body: unknown) { if (response.headersSent) { response.destroy(); return; } response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); }
async function bind(server: http.Server, endpoint: { host: string; port: number }) { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint.port, endpoint.host, resolve); }); }
function address(server: http.Server, host: string) { const value = server.address(); if (!value || typeof value === "string") throw new Error("listener unavailable"); return `http://${host.includes(":") ? `[${host}]` : host}:${value.port}`; }
