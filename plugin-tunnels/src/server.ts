import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer, connect, type Socket } from "node:net";
import { createSocket, type Socket as DatagramSocket, type RemoteInfo } from "node:dgram";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { TunnelStore, namePattern, object, parseRoute, type TunnelGrant, type TunnelRoute } from "./store.js";

export interface TunnelAuthority { current(grant: Pick<TunnelGrant, "workspaceId" | "workspaceName">): Promise<boolean> }
interface Flow { token: string; grant: TunnelGrant; route: TunnelRoute; close(): void }
export interface TunnelServer { relayPort: number; operatorPort: number; close(): Promise<void> }
export async function serveTunnels(store: TunnelStore, authority: TunnelAuthority, options: {
  relayHost: string; relayPort: number; operatorPort: number;
}): Promise<TunnelServer> {
  await store.read();
  const operatorScript = await readFile(new URL("./assets/operator.js", import.meta.url));
  let closed = false;
  const flows = new Set<Flow>(), pending = new Set<Socket>();
  const udpFlows = new Map<string, { socket: DatagramSocket; touched: number; flow: Flow }>();
  const relay = createTcpServer({ allowHalfOpen: true }, (client) => {
    if (closed || pending.size >= 1024) { client.destroy(); return; }
    pending.add(client); client.once("close", () => pending.delete(client));
    client.setTimeout(10_000, () => client.destroy());
    let header = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]); const end = header.indexOf(10);
      if (end < 0) { if (header.length > 4096) client.destroy(); return; }
      client.pause(); client.off("data", receive);
      if (end > 4096) { client.destroy(); return; }
      void establish(client, header.subarray(0, end), header.subarray(end + 1)).catch(() => client.destroy());
    };
    client.on("error", () => {}); client.on("data", receive);
  });
  async function authorize(data: Buffer, protocol: "tcp" | "udp") {
    const value: unknown = JSON.parse(data.toString("utf8"));
    if (!object(value) || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(value.token)) throw new Error("invalid tunnel credential");
    const config = await store.read(), grant = config.grants[value.token], route = grant && config.routes[grant.route];
    if (closed || !grant || !route || route.protocol !== protocol || !await authority.current(grant)) throw new Error("workspace tunnel is not authorized");
    return { token: value.token, grant, route };
  }
  async function establish(client: Socket, header: Buffer, remainder: Buffer) {
    const authorized = await authorize(header, "tcp");
    if (client.destroyed) return;
    const upstream = connect({ host: authorized.route.host, port: authorized.route.port, allowHalfOpen: true });
    const close = () => { client.destroy(); upstream.destroy(); flows.delete(flow); };
    const flow: Flow = { ...authorized, close }; flows.add(flow);
    upstream.on("error", close); client.once("error", close);
    client.once("close", close); upstream.once("close", close);
    upstream.once("connect", () => {
      if (client.destroyed) { close(); return; }
      client.setTimeout(0); client.write("OK\n");
      if (remainder.length) upstream.write(remainder);
      client.pipe(upstream); upstream.pipe(client); client.resume();
      // FIN may arrive while authority lookup/connect is in flight.
      if (client.readableEnded) upstream.end();
    });
  }
  const udp = createSocket("udp4");
  udp.on("error", () => {});
  // Serialize first packets per peer so asynchronous authorization cannot create duplicate sessions.
  const peerQueues = new Map<string, { done: Promise<void>; count: number }>();
  udp.on("message", (message, peer) => {
    const key = `${peer.address}:${peer.port}`;
    const previous = peerQueues.get(key);
    if (closed || (previous?.count ?? 0) >= 8 || (!previous && peerQueues.size >= 1024)) return;
    const entry = { done: (previous?.done ?? Promise.resolve()).then(() => datagram(message, peer)).catch(() => {}), count: (previous?.count ?? 0) + 1 };
    peerQueues.set(key, entry);
    void entry.done.finally(() => { const current = peerQueues.get(key); if (current) { current.count--; if (current.done === entry.done) peerQueues.delete(key); } });
  });
  async function datagram(message: Buffer, peer: RemoteInfo) {
    const end = message.indexOf(10);
    if (end < 0 || end > 4096 || message.length > 65_507) return;
    const authorized = await authorize(message.subarray(0, end), "udp");
    const key = `${authorized.token}:${peer.address}:${peer.port}`;
    let session = udpFlows.get(key);
    if (!session) {
      if (udpFlows.size >= 1024) return;
      const socket = createSocket("udp4");
      const close = () => { try { socket.close(); } catch { /* Already closed. */ } udpFlows.delete(key); flows.delete(flow); };
      const flow: Flow = { ...authorized, close };
      session = { socket, flow, touched: Date.now() }; udpFlows.set(key, session); flows.add(flow);
      socket.on("error", close);
      socket.on("message", (reply) => udp.send(reply, peer.port, peer.address, () => {}));
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); socket.connect(authorized.route.port, authorized.route.host); });
    }
    if (closed) { session.flow.close(); return; }
    session.touched = Date.now(); session.socket.send(message.subarray(end + 1), () => {});
  }
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return; checking = true;
    void (async () => {
      const config = await store.read();
      const identities = new Map<string, Promise<boolean>>();
      const checks: Promise<void>[] = [];
      for (const flow of flows) {
        const grant = config.grants[flow.token], route = grant && config.routes[grant.route];
        if (!grant || JSON.stringify(grant) !== JSON.stringify(flow.grant) || JSON.stringify(route) !== JSON.stringify(flow.route)) { flow.close(); continue; }
        const key = JSON.stringify([grant.workspaceName, grant.workspaceId]);
        let current = identities.get(key);
        if (!current) { current = authority.current(grant); identities.set(key, current); }
        checks.push(current.then((valid) => { if (!valid) flow.close(); }));
      }
      await Promise.all(checks);
      for (const session of udpFlows.values()) if (Date.now() - session.touched > 30_000) session.flow.close();
    })().catch(() => { for (const flow of flows) flow.close(); }).finally(() => { checking = false; });
  }, 500);
  timer.unref();
  const operator = createServer((request, response) => { void administration(request, response).catch((error: unknown) => {
    if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "invalid request" }));
  }); });
  async function administration(request: IncomingMessage, response: ServerResponse) {
    const config = await store.read();
    const expected = Buffer.from(`Basic ${Buffer.from(`${config.operator.username}:${config.operator.password}`).toString("base64")}`);
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="DIM tunnels"' }).end(); return;
    }
    response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff");
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
      response.end(operatorHtml); return;
    }
    if (request.method === "GET" && pathname === "/operator.js") { response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(operatorScript); return; }
    if (request.method === "GET" && pathname === "/v1/routes") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(config.routes)); return; }
    if (request.method === "GET" && pathname === "/v1/grants") {
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(Object.entries(config.grants).map(([token, grant]) => ({ token, ...grant })))); return;
    }
    if (!["POST", "DELETE"].includes(request.method ?? "")) { response.writeHead(404).end(); return; }
    const origin = request.headers.origin;
    if ((origin !== undefined && origin !== `http://${request.headers.host}`) || request.headers["content-type"]?.split(";")[0] !== "application/json") {
      response.writeHead(403).end(); return;
    }
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { const data = Buffer.from(chunk); bytes += data.length; if (bytes > 8192) throw new Error("request too large"); chunks.push(data); }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (request.method === "POST" && pathname === "/v1/routes") {
      if (!object(body) || typeof body.name !== "string" || !namePattern.test(body.name)) throw new Error("invalid route name");
      const name = body.name, route = parseRoute(body);
      await store.update((value) => { value.routes[name] = route; });
    } else if (request.method === "DELETE" && pathname.startsWith("/v1/routes/")) {
      const name = pathname.slice("/v1/routes/".length); if (!namePattern.test(name)) throw new Error("invalid route name");
      await store.update((value) => { delete value.routes[name]; for (const [token, grant] of Object.entries(value.grants)) if (grant.route === name) delete value.grants[token]; });
    } else if (request.method === "DELETE" && pathname.startsWith("/v1/grants/")) {
      const token = pathname.slice("/v1/grants/".length); await store.update((value) => { delete value.grants[token]; });
    } else { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": "application/json" }).end('{"updated":true}');
  }
  try {
    await new Promise<void>((resolve, reject) => { relay.once("error", reject); relay.listen(options.relayPort, options.relayHost, resolve); });
    const address = relay.address(); if (!address || typeof address === "string") throw new Error("relay did not bind");
    await new Promise<void>((resolve, reject) => { udp.once("error", reject); udp.bind(address.port, options.relayHost, resolve); });
    await new Promise<void>((resolve, reject) => { operator.once("error", reject); operator.listen(options.operatorPort, "127.0.0.1", resolve); });
    const admin = operator.address(); if (!admin || typeof admin === "string") throw new Error("operator did not bind");
    return { relayPort: address.port, operatorPort: admin.port, close };
  } catch (error) { await close(); throw error; }
  async function close() {
    if (closed) return; closed = true;
    clearInterval(timer); for (const socket of pending) socket.destroy(); for (const flow of flows) flow.close();
    await Promise.all([new Promise<void>((resolve) => { relay.close(() => resolve()); }), new Promise<void>((resolve) => { operator.closeAllConnections(); operator.close(() => resolve()); })]);
    try { udp.close(); } catch { /* Partial startup before UDP bind. */ }
  }
}
const operatorHtml = `<!doctype html><meta charset="utf-8"><title>DIM tunnels</title><style>body{font:16px system-ui;max-width:900px;margin:3rem auto}input,select,button{font:inherit;margin:.3rem}pre{white-space:pre-wrap}</style><h1>Workspace tunnels</h1><p>Targets are selected by the operator. Workspace credentials can use only their assigned route.</p><form id="add"><input name="name" placeholder="route name" required><select name="protocol"><option>tcp</option><option>udp</option></select><input name="host" placeholder="target hostname" required><input name="port" type="number" min="1" max="65535" required><button>Add route</button></form><h2>Routes</h2><div id="routes"></div><h2>Workspace access</h2><div id="grants"></div><p id="error"></p><script src="/operator.js" defer></script>`;
