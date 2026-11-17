import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export interface NameIngressConfig { readonly listen: string; readonly port?: number; readonly upstreams: () => ReadonlyMap<string, string> }
export interface NameIngressHandle { readonly port: number; readonly close: () => void; readonly closed: Promise<void> }

/** Generic Host-routed reverse proxy: name -> upstream only, never a protocol it forwards. */
export async function createNameIngress(config: NameIngressConfig): Promise<NameIngressHandle> {
  const sockets = new Set<Socket>();
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    void handle(request, response).catch(() => { if (response.headersSent) response.destroy(); else { response.writeHead(502); response.end(); } });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1_000; server.maxConnections = 128;
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = (request.headers.host ?? "").split(":")[0]!.toLowerCase();
    const upstream = host.length > 0 ? config.upstreams().get(host) : undefined;
    if (!upstream) { request.resume(); response.writeHead(404); response.end(); return; }
    const target = new URL(upstream);
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && name !== "host") headers[name] = value;
    headers.host = target.host;
    const outgoing = httpRequest({ hostname: target.hostname, port: target.port || undefined, method: request.method, path: request.url, headers }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.on("error", () => response.destroy());
      incoming.pipe(response);
    });
    const headersDeadline = setTimeout(() => outgoing.destroy(new Error("ingress upstream headers timed out")), 10_000);
    outgoing.once("response", () => clearTimeout(headersDeadline)); outgoing.once("close", () => clearTimeout(headersDeadline));
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error("ingress upstream became idle")));
    outgoing.on("error", () => { if (response.headersSent) response.destroy(); else { response.writeHead(502); response.end(); } });
    response.on("close", () => { if (!response.writableEnded) outgoing.destroy(); });
    request.on("aborted", () => outgoing.destroy());
    request.pipe(outgoing);
  }

  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port ?? 80, config.listen, resolve); });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("name ingress listener unavailable");

  let closing = false, didClose: () => void = () => {};
  const closed = new Promise<void>((resolve) => { didClose = resolve; });
  function close(): void {
    if (closing) return; closing = true;
    for (const socket of sockets) socket.destroy();
    server.close(() => didClose());
  }
  return { port: address.port, close, closed };
}
