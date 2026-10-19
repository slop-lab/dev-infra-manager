import { randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import path from "node:path";
import { once } from "node:events";
import WebSocket, { createWebSocketStream, WebSocketServer } from "ws";
import { UserError } from "@slop-lab/dim-host-core/workspace";
import { object, text, type VmHostConfig } from "./config.js";
import { digest, equal, PersistentVmService } from "./store.js";

interface Session { vm: string; token: string; expires: number }
export interface ConsoleServerOptions { token: string; host: string; port: number; assets: string }
/** The browser receives a scoped binary SPICE stream. Incus credentials and operation secrets stay here. */
export async function serveVmConsole(service: PersistentVmService, config: VmHostConfig, options: ConsoleServerOptions): Promise<Server> {
  if (options.token.length < 32) throw new UserError("VM console owner token must contain at least 32 characters");
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) throw new UserError("invalid VM console port");
  const assetRoot = await realpath(options.assets);
  if (!(await stat(path.join(assetRoot, "main.js"))).isFile()) throw new UserError("reviewed spice-html5 assets must contain main.js");
  const sessions = new Map<string, Session>();
  const ownerHash = digest(options.token);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
  const active = new Set<WebSocket>();
  const authorized = async (incoming: IncomingMessage, vm: string) => {
    const session = cookie(incoming, sessions);
    const token = incoming.headers.authorization?.replace(/^Bearer /, "") ?? session?.token;
    if (token === undefined || (session && session.vm !== vm)) return false;
    if (equal(digest(token), ownerHash)) { await service.read(vm); return true; }
    return await service.authorize(vm, token) !== undefined;
  };
  const server = createServer((incoming, response) => { void handle(incoming, response).catch((error: unknown) => {
    if (!response.headersSent) response.writeHead(400, { "content-type": "text/plain" });
    response.end(error instanceof Error ? error.message : "VM console request failed");
  }); });
  const handle = async (incoming: IncomingMessage, response: ServerResponse) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    const url = new URL(incoming.url ?? "/", "http://localhost");
    if (incoming.method === "POST" && url.pathname === "/session") {
      if (incoming.headers.origin !== undefined && incoming.headers.origin !== `http://${incoming.headers.host}`
        && incoming.headers.origin !== `https://${incoming.headers.host}`) throw new UserError("cross-origin VM console login rejected");
      const body = object(JSON.parse(await limitedBody(incoming)));
      const vm = text(body.vm), token = text(body.token);
      if (!(equal(digest(token), ownerHash) ? await service.read(vm) : await service.authorize(vm, token))) {
        response.writeHead(403); response.end("VM access denied"); return;
      }
      const id = randomBytes(32).toString("base64url");
      if (sessions.size >= 1024) {
        for (const [key, session] of sessions) if (session.expires < Date.now()) sessions.delete(key);
        if (sessions.size >= 1024) throw new UserError("too many active VM console sessions");
      }
      sessions.set(id, { vm, token, expires: Date.now() + 3600_000 });
      response.setHeader("set-cookie", `dim_vm=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
      response.writeHead(204); response.end(); return;
    }
    if (incoming.method === "GET" && url.pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8"); response.end(consolePage); return;
    }
    if (incoming.method === "GET" && url.pathname === "/client.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(await readFile(new URL("./browser.js", import.meta.url))); return;
    }
    if (incoming.method === "GET" && url.pathname.startsWith("/assets/")) {
      // Console assets are public static code. They contain no session or service credentials.
      const file = await realpath(path.join(assetRoot, decodeURIComponent(url.pathname.slice(8))));
      if (!file.startsWith(`${assetRoot}/`) || !(await stat(file)).isFile()) throw new UserError("invalid console asset");
      response.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream");
      response.end(await readFile(file)); return;
    }
    if (incoming.method === "GET" && url.pathname.startsWith("/state/")) {
      const vm = decodeURIComponent(url.pathname.slice(7));
      if (!await authorized(incoming, vm)) { response.writeHead(403); response.end("VM access denied"); return; }
      const record = await service.read(vm);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name: record.name, running: (await service.machines.inspect(record))?.running ?? false })); return;
    }
    response.writeHead(404); response.end("not found");
  };
  server.on("upgrade", (incoming, socket, head) => {
    void (async () => {
      const url = new URL(incoming.url ?? "/", "http://localhost");
      const origin = incoming.headers.origin;
      if ((origin !== `http://${incoming.headers.host}` && origin !== `https://${incoming.headers.host}`)
        || !url.pathname.startsWith("/stream/")) throw new UserError("VM console upgrade rejected");
      const vm = decodeURIComponent(url.pathname.slice(8));
      if (!await authorized(incoming, vm)) throw new UserError("VM access denied");
      const record = await service.read(vm);
      const actual = await service.machines.inspect(record);
      if (!actual?.running) throw new UserError("VM must be running before opening its console");
      const upstream = await openIncusConsole(config, service.machines.name(record));
      sockets.handleUpgrade(incoming, socket, head, (client) => {
        active.add(client);
        const source = createWebSocketStream(upstream.data, { highWaterMark: 64 * 1024 });
        const target = createWebSocketStream(client, { highWaterMark: 64 * 1024 });
        let closed = false;
        const close = () => {
          if (closed) return; closed = true;
          clearInterval(recheck); active.delete(client);
          source.destroy(); target.destroy(); client.terminate(); upstream.data.terminate(); upstream.control.terminate();
        };
        // Existing sessions lose access after revoke, stop/discard or workspace name reuse.
        const recheck = setInterval(() => { void authorized(incoming, vm).then((allowed) => { if (!allowed) close(); }, close); }, 1000);
        source.once("error", close); target.once("error", close);
        client.once("close", close); upstream.data.once("close", close); upstream.control.once("close", close);
        source.pipe(target).pipe(source);
      });
    })().catch(() => { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); });
  });
  server.once("close", () => { for (const client of active) client.terminate(); sockets.close(); sessions.clear(); });
  server.listen(options.port, options.host);
  await once(server, "listening");
  return server;
}
async function openIncusConsole(config: VmHostConfig, instance: string): Promise<{ data: WebSocket; control: WebSocket }> {
  const envelope = object(await unixJson(config.incusSocket, `/1.0/instances/${encodeURIComponent(instance)}/console?project=${encodeURIComponent(config.project)}`, { type: "vga" }));
  const operation = object(envelope.metadata), metadata = object(operation.metadata), fds = object(metadata.fds);
  const operationId = text(operation.id), dataSecret = text(fds["0"]), controlSecret = text(fds.control);
  if (!/^[a-zA-Z0-9-]+$/.test(operationId)) throw new UserError("invalid Incus console operation");
  const connect = (secret: string) => new WebSocket(`ws+unix://${config.incusSocket}:/1.0/operations/${operationId}/websocket?secret=${encodeURIComponent(secret)}`, {
    perMessageDeflate: false, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 10_000
  });
  const data = connect(dataSecret), control = connect(controlSecret);
  try { await Promise.all([once(data, "open"), once(control, "open")]); }
  catch (error) { data.terminate(); control.terminate(); throw error; }
  return { data, control };
}
async function unixJson(socketPath: string, endpoint: string, body: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, path: endpoint, method: "POST", headers: { "content-type": "application/json" }, timeout: 10_000 }, (incoming) => {
      void limitedBody(incoming).then((data) => {
        if (incoming.statusCode !== 202) throw new UserError("Incus rejected VM console creation");
        resolve(JSON.parse(data));
      }).catch(reject);
    });
    outgoing.once("error", reject); outgoing.once("timeout", () => outgoing.destroy(new Error("Incus console request timed out")));
    outgoing.end(JSON.stringify(body));
  });
}
async function limitedBody(incoming: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const input of incoming) {
    const chunk: unknown = input;
    if (!Buffer.isBuffer(chunk)) throw new UserError("invalid console request body");
    length += chunk.length;
    if (length > 65536) throw new UserError("console request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function cookie(incoming: IncomingMessage, sessions: Map<string, Session>): Session | undefined {
  const id = incoming.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("dim_vm="))?.slice(7);
  const session = id === undefined ? undefined : sessions.get(id);
  return session && session.expires > Date.now() ? session : undefined;
}
const consolePage = `<!doctype html><html><head><meta charset="utf-8"><title>DIM VM console</title></head><body>
<h1>VM console</h1><form id="login"><label>VM <input name="vm" required></label><label>Access token <input name="token" type="password" required></label><button>Connect</button></form>
<p id="status"></p><div id="screen"></div><div id="messages"></div><script type="importmap">{"imports":{"dim-spice":"/assets/main.js"}}</script><script type="module" src="/client.js"></script></body></html>`;
