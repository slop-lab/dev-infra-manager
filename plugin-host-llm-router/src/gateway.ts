import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { lstat, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceRecord, WorkspaceStore } from "@slop-lab/dim-core/workspace";
import { tryAcquireKernelGuard } from "@slop-lab/dim-core";
import { object, privateFile, text, type HostRouterConfig } from "./config.js";
import type { IssuedPrincipal, PrincipalScope } from "./client.js";

interface Attachment extends PrincipalScope { cpToken: string; principalId: string }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function attachmentDirectory(config: HostRouterConfig): Promise<string> {
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const stat = await lstat(config.stateDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0) throw new Error("host gateway state must be private and owned");
  const path = join(config.stateDirectory, "attachments"); await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  const directory = await lstat(path);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.geteuid?.() || (directory.mode & 0o077) !== 0) throw new Error("unsafe attachment directory");
  return path;
}
export async function lockWorkspaceAttachment(config: HostRouterConfig, workspaceId: string) {
  await attachmentDirectory(config);
  return tryAcquireKernelGuard(join(config.stateDirectory, `attach-${workspaceId}.guard`));
}
export async function createAttachment(config: HostRouterConfig, scope: PrincipalScope, issued: IssuedPrincipal) {
  const token = randomBytes(32).toString("base64url"), directory = await attachmentDirectory(config);
  const path = join(directory, `${digest(token)}.json`);
  await writeFile(path, JSON.stringify({ ...scope, cpToken: issued.token, principalId: issued.principalId }), { mode: 0o600, flag: "wx" });
  return { token, async remove() { await unlink(path); }, async activate(): Promise<PrincipalScope[]> {
    const previous: { file: string; scope: PrincipalScope }[] = [];
    for (const file of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file) || file === `${digest(token)}.json`) continue;
      try {
        const row = object(JSON.parse(await privateFile(join(directory, file), 16 * 1024)));
        if (row.workspaceId === scope.workspaceId) previous.push({ file, scope: {
          bindingId: text(row.bindingId), workspaceId: text(row.workspaceId), workspaceName: text(row.workspaceName),
          projectId: text(row.projectId), routeId: text(row.routeId)
        } });
      } catch { /* A malformed private grant is already rejected by the gateway. */ }
    }
    // One atomic current binding fences old tokens/streams even if cleanup of
    // an obsolete grant or its remote CP principal later fails.
    const current = join(directory, `.current-${scope.workspaceId}.json`), temporary = `${current}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ tokenHash: digest(token) }), { flag: "wx", mode: 0o600 }); await rename(temporary, current); }
    finally { await unlink(temporary).catch((error: unknown) => { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }); }
    const removed = await Promise.allSettled(previous.map(({ file }) => unlink(join(directory, file))));
    const failed = removed.filter((result) => result.status === "rejected").length;
    if (failed) console.warn(`Replaced attachment locally; ${failed} obsolete private grant file(s) need cleanup.`);
    return previous.map(({ scope }) => scope);
  } };
}
export async function createHostGateway(config: HostRouterConfig, store: WorkspaceStore) {
  if (store.root !== config.workspaceStateRoot) throw new Error("gateway and selected host workspace roots differ");
  const directory = await attachmentDirectory(config), guard = await tryAcquireKernelGuard(join(config.stateDirectory, "gateway.guard"));
  if (!guard) throw new Error("host LLM gateway is already running");
  const active = new Set<() => void>();
  async function bound(scope: PrincipalScope, token: string): Promise<boolean> {
    try { const pointer = object(JSON.parse(await privateFile(join(directory, `.current-${scope.workspaceId}.json`), 1024)));
      return pointer.tokenHash === digest(token);
    } catch { return false; }
  }
  let closing: Promise<void> | undefined;
  async function current(scope: PrincipalScope): Promise<boolean> {
    try { const workspace: WorkspaceRecord = await store.read(scope.workspaceName);
      return workspace.id === scope.workspaceId && workspace.initialized && workspace.phase === "running";
    } catch { return false; }
  }
  const server = createServer((incoming, response) => {
    void (async () => {
      const path = incoming.url ?? "";
      if (!/^\/v1\/(?:models|usage|capabilities|responses|chat\/completions|requests\/[0-9a-f-]{36}(?:\/(?:capture|request|response|cancel))?)$/.test(path)
        || !["GET", "POST"].includes(incoming.method ?? "")) return deny(response, 404);
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(incoming.headers.authorization ?? "")?.[1];
      if (!token) return deny(response, 401);
      const file = join(directory, `${digest(token)}.json`);
      let grant: Attachment;
      try {
        const row = object(JSON.parse(await privateFile(file, 16 * 1024)));
        grant = { bindingId: text(row.bindingId), workspaceId: text(row.workspaceId), workspaceName: text(row.workspaceName), projectId: text(row.projectId),
          routeId: text(row.routeId), principalId: text(row.principalId), cpToken: text(row.cpToken) };
        if (!/^[A-Za-z0-9_-]{43}$/.test(grant.cpToken) || (!await current(grant) || !await bound(grant, token))) return deny(response, 401);
      } catch { return deny(response, 401); }
      if (response.destroyed || closing !== undefined) return;
      const target = new URL(config.connection.endpoint + path);
      const remote = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: incoming.method,
        headers: { authorization: `Bearer ${grant.cpToken}`, "content-type": "application/json", accept: incoming.headers.accept ?? "application/json" } });
      let finished = false, bytes = 0, checking = false;
      const stop = () => { remote.destroy(); incoming.unpipe(remote); if (!response.writableEnded) response.destroy(); };
      const cleanup = () => { if (finished) return; finished = true; clearInterval(watch); active.delete(stop);
        incoming.off("aborted", stop); response.off("close", stop); };
      const watch = setInterval(() => {
        if (checking) return; checking = true;
        void Promise.all([current(grant), bound(grant, token), privateFile(file, 16 * 1024)]).then(([valid, selected]) => { if (!valid || !selected) stop(); }, stop)
          .finally(() => { checking = false; });
      }, 250); watch.unref();
      active.add(stop); incoming.once("aborted", stop); response.once("close", stop); response.once("close", cleanup);
      remote.once("error", () => { if (!response.headersSent) deny(response, 502); else response.destroy(); cleanup(); });
      remote.once("response", (upstream) => {
        const headers: Record<string, string> = { "cache-control": "no-store" };
        for (const name of ["content-type", "content-disposition", "x-dim-request-id", "x-dim-error-category", "x-content-type-options"]) {
          const value = upstream.headers[name]; if (typeof value === "string") headers[name] = value;
        }
        response.writeHead(upstream.statusCode ?? 502, headers); upstream.pipe(response);
        upstream.once("error", stop); upstream.once("end", cleanup);
      });
      incoming.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) stop(); });
      incoming.pipe(remote);
    })().catch(() => { if (!response.headersSent) deny(response, 503); else response.destroy(); });
  });
  server.maxConnections = 128; server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.keepAliveTimeout = 1000;
  return { server, close() { return closing ??= (async () => { for (const stop of active) stop(); server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); await guard.release(); })(); } };
}
function deny(response: ServerResponse, status: number): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ error: "host LLM gateway request denied" }));
}
