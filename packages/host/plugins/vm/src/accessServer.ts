import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { UserError } from "@slop-lab/dim-host-core/workspace";
import { VmAccessService, type VmAccessIdentity } from "./access.js";
import type { VmPermission } from "./store.js";

export interface VmAccessServerOptions { readonly host: string; readonly port: number; readonly recheckMilliseconds?: number }
type AuthorizationWatch = { readonly access: VmAccessService; readonly identity: VmAccessIdentity;
  readonly permission: VmPermission; readonly recheckMilliseconds?: number };
type HttpExchange = { readonly request: IncomingMessage; readonly response: ServerResponse };

export async function serveVmAccess(access: VmAccessService, options: VmAccessServerOptions): Promise<Server> {
  const server = createServer((request, response) => { void handle(request, response).catch((error: unknown) => {
    if (!response.headersSent) json(response, error instanceof UserError ? 403 : 503,
      { error: error instanceof UserError ? error.message : "VM access service unavailable" });
    else response.destroy();
  }); });
  server.requestTimeout = 0; server.headersTimeout = 5_000; server.keepAliveTimeout = 1_000;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin !== undefined) throw new UserError("VM access denied");
    const url = new URL(request.url ?? "/", "http://localhost"), match = /^\/v1\/vms\/([0-9a-f-]{36})(?:\/(.*))?$/.exec(url.pathname);
    if (!match?.[1]) { json(response, 404, { error: "unknown VM access operation" }); return; }
    const identity = parseIdentity(request, match[1]);
    if (request.method === "GET" && match[2] === "status") {
      json(response, 200, await access.status(identity)); return;
    }
    if (request.method === "POST" && match[2] === "exec") {
      const command = commandHeader(request.headers["x-dim-command"]);
      await streamAuthorization({ access, identity, permission: "exec",
        ...(options.recheckMilliseconds === undefined ? {} : { recheckMilliseconds: options.recheckMilliseconds }) },
        { request, response }, async (signal) => {
        response.writeHead(200, { "content-type": "application/vnd.dim.vm-exec" });
        const code = await access.exec({ ...identity, command, options: { stdin: request, stdout: framed(response, 1),
          stderr: framed(response, 2), signal } });
        response.end(frame(3, Buffer.from(String(code))));
      }); return;
    }
    if (request.method === "POST" && match[2] === "copy") {
      const direction = url.searchParams.get("direction"), vmPath = url.searchParams.get("path");
      if ((direction !== "push" && direction !== "pull") || !vmPath) throw new UserError("invalid VM copy request");
      await streamAuthorization({ access, identity, permission: "copy",
        ...(options.recheckMilliseconds === undefined ? {} : { recheckMilliseconds: options.recheckMilliseconds }) },
        { request, response }, async (signal) => {
        if (direction === "pull") response.writeHead(200, { "content-type": "application/vnd.dim.copy" });
        const code = await access.copy({ ...identity, direction, path: vmPath,
          recursive: url.searchParams.get("recursive") === "1", overwrite: url.searchParams.get("overwrite") === "1",
          options: { signal, ...(direction === "push" ? { stdin: request } : { stdout: response }) } });
        if (code !== 0) throw new UserError(`VM copy failed with exit ${code}`);
        if (direction === "push") response.writeHead(204);
        response.end();
      }); return;
    }
    const lifecycle = /^lifecycle\/(start|stop)$/.exec(match[2] ?? "");
    if (request.method === "POST" && lifecycle?.[1]) {
      const operation = lifecycle[1];
      if (operation !== "start" && operation !== "stop") throw new UserError("invalid VM lifecycle operation");
      await access.lifecycle({ ...identity, operation }); response.writeHead(204); response.end(); return;
    }
    json(response, 404, { error: "unknown VM access operation" });
  }

  server.listen(options.port, options.host); await once(server, "listening"); return server;
}

function parseIdentity(request: IncomingMessage, vmId: string): VmAccessIdentity {
  const token = request.headers.authorization?.replace(/^Bearer /, ""), vmName = one(request.headers["x-dim-vm-name"]),
    workspaceId = one(request.headers["x-dim-workspace-id"]), grantId = one(request.headers["x-dim-grant-id"]),
    generation = Number(one(request.headers["x-dim-grant-generation"]));
  if (!token || !vmName || !workspaceId || !grantId || !Number.isSafeInteger(generation) || generation < 1) throw new UserError("VM access denied");
  return { token, vmId, vmName, workspaceId, grantId, generation };
}

async function streamAuthorization(watch: AuthorizationWatch, exchange: HttpExchange,
  action: (signal: AbortSignal) => Promise<void>): Promise<void> {
  if (!await watch.access.isAuthorized(watch.identity, watch.permission)) throw new UserError("VM access denied or expired");
  const abort = new AbortController(), stop = () => abort.abort();
  exchange.request.once("aborted", stop); exchange.response.once("close", stop);
  const timer = setInterval(() => { void watch.access.isAuthorized(watch.identity, watch.permission)
    .then((allowed) => { if (!allowed) abort.abort(); }, stop); }, watch.recheckMilliseconds ?? 1_000);
  try { await action(abort.signal); }
  finally { clearInterval(timer); exchange.request.off("aborted", stop); exchange.response.off("close", stop); }
}

function commandHeader(value: string | string[] | undefined): string[] {
  if (typeof value !== "string" || value.length > 16_384) throw new UserError("invalid VM command");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new UserError("invalid VM command"); }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 256
    || !parsed.every((argument: unknown): argument is string => typeof argument === "string" && !argument.includes("\0"))) {
    throw new UserError("invalid VM command");
  }
  return parsed;
}
function one(value: string | string[] | undefined): string | undefined { return typeof value === "string" ? value : undefined; }
function frame(channel: number, body: Buffer): Buffer { const header = Buffer.alloc(5); header.writeUInt8(channel); header.writeUInt32BE(body.length, 1); return Buffer.concat([header, body]); }
function framed(response: ServerResponse, channel: number): Writable { return new Writable({ write(chunk, _encoding, done) {
  if (response.write(frame(channel, Buffer.from(chunk)))) done(); else response.once("drain", done);
} }); }
function json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
