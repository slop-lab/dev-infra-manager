/** Self-contained workspace-side adapter. It never touches a host Docker socket. */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { chmod, chown, lstat, rename, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const maximumCreateBytes = 2 * 1024 * 1024;
export interface GuestProxyConfig {
  socket: string; engineSocket: string; files: readonly { readonly source: string; readonly target: string }[];
  environmentDefaults: readonly string[];
  blockedHostnames: readonly string[];
}
function object(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Docker configuration must be an object");
  return input as Record<string, unknown>;
}
export function injectMirrorMounts(input: unknown, config: GuestProxyConfig) {
  const body = object(input), host = body.HostConfig === undefined || body.HostConfig === null ? {} : object(body.HostConfig);
  const binds: string[] = host.Binds === undefined || host.Binds === null ? [] : strings(host.Binds);
  const mounts = host.Mounts === undefined || host.Mounts === null ? [] : host.Mounts;
  if (!Array.isArray(mounts)) throw new Error("Docker mounts must be an array");
  const destinations = new Set([...binds.map((bind) => bind.split(":")[1]), ...mounts.map((mount: unknown) => object(mount).Target)]);
  for (const { source, target } of config.files) {
    if (!destinations.has(target)) binds.push(`${source}:${target}:ro`);
  }
  const extra = host.ExtraHosts === undefined || host.ExtraHosts === null ? [] : strings(host.ExtraHosts);
  for (const hostname of config.blockedHostnames) if (!extra.some((entry) => entry.startsWith(`${hostname}:`) || entry.startsWith(`${hostname}=`))) extra.push(`${hostname}:127.0.0.1`);
  const environment = body.Env === undefined || body.Env === null ? [] : strings(body.Env);
  for (const entry of config.environmentDefaults) {
    const key = entry.slice(0, entry.indexOf("=")).toLowerCase();
    if (!environment.some((value) => value.split("=", 1)[0]?.toLowerCase() === key)) environment.push(entry);
  }
  return { ...body, Env: environment, HostConfig: { ...host, Binds: binds, ExtraHosts: extra } };
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry: unknown) => typeof entry !== "string")) throw new Error("Docker configuration must contain strings");
  return [...value] as string[];
}
export function createGuestDockerProxy(config: GuestProxyConfig) {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request, response) => {
    void route(request, response).catch(() => {
      if (response.headersSent) response.destroy(); else { response.writeHead(400, { "content-type": "application/json" }); response.end('{"message":"invalid mirror container configuration"}'); }
    });
  });
  server.requestTimeout = 0;
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, socket, head) => {
    socket.allowHalfOpen = true;
    const upstream = connect({ path: config.engineSocket, allowHalfOpen: true });
    sockets.add(upstream); upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
    upstream.once("connect", () => {
      upstream.write(`${request.method ?? "POST"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n${request.rawHeaders.reduce((text, value, index) => text + value + (index % 2 === 0 ? ": " : "\r\n"), "")}\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
  });
  return { server, async close() {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
  async function route(request: IncomingMessage, response: ServerResponse) {
    let body: Buffer | undefined;
    if (request.method === "POST" && /^\/(?:v[0-9]+\.[0-9]+\/)?containers\/create(?:\?|$)/.test(request.url ?? "")) {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maximumCreateBytes) throw new Error("container configuration too large"); chunks.push(bytes); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      body = Buffer.from(JSON.stringify(injectMirrorMounts(value, config)));
    }
    response.setHeader("x-dim-mirror-proxy", "1");
    const headers = { ...request.headers };
    if (body !== undefined) { delete headers["transfer-encoding"]; headers["content-length"] = String(body.length); }
    const outgoing = httpRequest({ socketPath: config.engineSocket, method: request.method, path: request.url, headers }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      response.flushHeaders();
      incoming.on("error", () => response.destroy()); incoming.pipe(response);
    });
    outgoing.on("error", () => { if (response.headersSent) response.destroy(); else { response.writeHead(502); response.end(); } });
    request.on("aborted", () => outgoing.destroy());
    response.on("close", () => { if (!response.writableEnded) outgoing.destroy(); });
    if (body !== undefined) outgoing.end(body); else request.pipe(outgoing);
  }
}
async function engineAvailable(socket: string) {
  return new Promise<boolean>((resolve) => {
    const request = httpRequest({ socketPath: socket, path: "/_ping", signal: AbortSignal.timeout(2_000) }, (response) => { response.resume(); resolve(response.statusCode === 200); });
    request.on("error", () => resolve(false)); request.end();
  });
}
export async function runGuestDockerProxy(input: unknown): Promise<void> {
  const value = object(input);
  const localPath = (value: unknown): value is string => typeof value === "string" && value.startsWith("/") && !/[:,\0]/.test(value);
  if (!localPath(value.socket) || !localPath(value.engineSocket) || !Array.isArray(value.files)) throw new Error("mirror paths must be absolute local paths");
  const files: { source: string; target: string }[] = [];
  for (const item of value.files) {
    const file = object(item);
    if (!localPath(file.source) || !localPath(file.target)) throw new Error("mirror paths must be absolute local paths");
    files.push({ source: file.source, target: file.target });
  }
  const environmentDefaults = strings(value.environmentDefaults);
  if (environmentDefaults.some((entry) => !/^[A-Za-z_][A-Za-z0-9_]*=[^\0]*$/.test(entry))) throw new Error("invalid mirror environment default");
  const config: GuestProxyConfig = { socket: value.socket, engineSocket: value.engineSocket, files, environmentDefaults, blockedHostnames: strings(value.blockedHostnames) };
  for (const name of config.blockedHostnames) if (!/^[a-z0-9.-]+$/.test(name)) throw new Error("invalid blocked registry hostname");
  // A stopped shim leaves the real nested engine alive at engineSocket. A guest
  // restart starts a new engine at socket; the old engine socket no longer answers.
  if (await engineAvailable(config.engineSocket)) {
    try { if (!(await lstat(config.socket)).isSocket()) throw new Error("Docker listener is not a socket"); await rm(config.socket); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
  } else {
    if (!(await lstat(config.socket)).isSocket()) throw new Error("nested Docker socket is missing");
    try { if (!(await lstat(config.engineSocket)).isSocket()) throw new Error("mirror engine path is occupied"); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
    await rename(config.socket, config.engineSocket);
  }
  const owner = await lstat(config.engineSocket), proxy = createGuestDockerProxy(config);
  await new Promise<void>((resolve, reject) => { proxy.server.once("error", reject); proxy.server.listen(config.socket, resolve); });
  await chown(config.socket, owner.uid, owner.gid); await chmod(config.socket, 0o660);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void proxy.close(); });
}
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runGuestDockerProxy(JSON.parse(process.argv[2] ?? "null")).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "mirror guest setup failed"); process.exitCode = 1; });
}
