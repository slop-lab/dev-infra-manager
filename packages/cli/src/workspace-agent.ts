import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  ProcessRunner, UserError, WorkspaceService, WorkspaceStore, deployGuestIntegration, workspaceGuestAssets,
  type WorkspaceHostPluginContext, type WorkspaceRecord, type WorkspaceRuntime
} from "@slop-lab/dim-host-core/workspace";
import { atomicWrite } from "@slop-lab/dim-host-core";
import { composeWorkspaceRuntime, loadHostPlugins, hostPluginHome, hostPluginExtensions } from "./host-plugins.js";
import { ensureWorkspaceIntegration } from "./workspace-composition.js";

interface AgentConfiguration {
  workspaceId: string;
  workspaceName: string;
  stateRoot: string;
  host: string;
  token: string;
  generation: string;
}
type StoredAgentConfiguration = Omit<AgentConfiguration, "generation"> & { generation?: string };
interface AgentReady { endpoint: string; workspaceId: string }
export interface AgentHostContext extends WorkspaceHostPluginContext { readonly runtime: WorkspaceRuntime }

function directory(store: WorkspaceStore, id: string): string { return path.join(store.root, "agents", id); }

/** A small per-workspace process survives CLI/SSH disconnects. It has no host-admin route. */
export async function ensureWorkspaceAgent(record: WorkspaceRecord, context: AgentHostContext): Promise<void> {
  await context.store.withLock(record.name, async () => {
    const current = await context.store.read(record.name);
    if (current.id !== record.id || current.phase !== "running") throw new UserError("workspace changed before its scoped service bridge was ready");
    const root = directory(context.store, record.id), file = path.join(root, "config.json");
    await mkdir(root, { recursive: true, mode: 0o700 });
    let stored: StoredAgentConfiguration | undefined;
    try { stored = parseStoredConfiguration(await privateJson(file)); }
    catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    if (stored && (stored.workspaceId !== record.id || stored.workspaceName !== record.name || stored.stateRoot !== context.stateRoot)) throw new UserError("workspace service bridge identity conflicts with its state");
    const host = await context.runtime.hostGateway?.(record);
    if (!host || !privateAddress(host)) throw new UserError("workspace runtime has no private host service gateway");
    const generation = await workspaceAgentGeneration();
    const changed = !stored || stored.host !== host || stored.generation !== generation;
    let config: AgentConfiguration = { workspaceId: record.id, workspaceName: record.name,
      stateRoot: context.stateRoot, host, generation, token: changed || !stored ? randomBytes(32).toString("base64url") : stored.token };
    if (changed) await atomicWrite(file, config);
    let ready = await agentReady(root, config);
    if (!ready) {
      // An unreachable process may still be alive. Revoke its token before
      // publishing another ephemeral listener, even within the same generation.
      if (!changed) {
        config = { ...config, token: randomBytes(32).toString("base64url") };
        await atomicWrite(file, config);
      }
      const script = process.argv[1];
      if (!script) throw new UserError("cannot locate the host service bridge entrypoint");
      const log = await open(path.join(root, "service.log"), "a", 0o600);
      try {
        const child = spawn(process.execPath, [...process.execArgv, script, "__agent", file], {
          detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env
        });
        let failure: Error | undefined;
        child.on("error", (error) => { failure = error; }); child.unref();
        for (let attempt = 0; attempt < 100; attempt++) {
          ready = await agentReady(root, config);
          if (ready) break;
          if (failure || child.exitCode !== null || child.signalCode !== null) throw new UserError(`workspace service bridge exited; see ${root}/service.log`, failure ? { cause: failure } : undefined);
          context.signal.throwIfAborted();
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
      } finally { await log.close(); }
      if (!ready) throw new UserError(`workspace service bridge did not become ready; see ${root}/service.log`);
    }
    const payload = JSON.stringify({ endpoint: ready.endpoint, token: config.token, workspaceId: record.id });
    await deployGuestIntegration({ service: context.service, workspace: record, signal: context.signal }, {
      name: "workspace-connection", files: [
        ...await Promise.all(workspaceGuestAssets().filter(({ name }) => name === "dim-workspace" || name === "dim-nproc")
          .map(async ({ name, sourcePath }) => ({ path: `.local/bin/${name}`, contents: await readFile(sourcePath), mode: 0o700 as const }))),
        { path: ".config/dim/workspace.json", contents: payload }
      ]
    });
  });
  const installed = await loadHostPlugins();
  const pluginContext = { ...context, extensions: hostPluginExtensions(installed) };
  for (const plugin of installed) await plugin.workspaceReady?.(record, pluginContext);
}

async function agentReady(root: string, config: AgentConfiguration): Promise<AgentReady | undefined> {
  try {
    const raw = await privateJson(path.join(root, "ready.json"));
    if (!isObject(raw) || raw.workspaceId !== config.workspaceId || typeof raw.endpoint !== "string") return;
    const endpoint = new URL(raw.endpoint);
    if (endpoint.origin !== raw.endpoint || endpoint.protocol !== "http:" || endpoint.hostname !== config.host || !endpoint.port) return;
    const response = await fetch(`${endpoint.origin}/v1/resources`, { redirect: "error", headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(500) });
    await response.body?.cancel();
    if (response.status !== 200 || response.headers.get("x-dim-bridge-generation") !== config.generation) return;
    return { endpoint: endpoint.origin, workspaceId: config.workspaceId };
  } catch (error) {
    if (hasCode(error, "ENOENT") || error instanceof TypeError || error instanceof DOMException) return;
    throw error;
  }
}

/** Separate entrypoint: only a private, host-owned configuration can start a bridge. */
export async function runWorkspaceAgent(file: string): Promise<void> {
  const config = parseConfiguration(await privateJson(file));
  if (config.generation !== await workspaceAgentGeneration()) throw new UserError("workspace bridge generation changed before startup; run the workspace command again");
  const runner = new ProcessRunner();
  const store = new WorkspaceStore(config.stateRoot);
  const composition = composeWorkspaceRuntime({ runner, cleanupRunner: runner, stateRoot: store.root });
  const service = new WorkspaceService(store, composition.runtime, async () => { throw new UserError("agent connections cannot create workspaces"); });
  const abort = new AbortController();
  const context: AgentHostContext = { runner, cleanupRunner: runner, stateRoot: store.root, store, service, signal: abort.signal, runtime: composition.runtime };
  const current = await store.read(config.workspaceName);
  if (current.id !== config.workspaceId || await composition.runtime.hostGateway?.(current) !== config.host) throw new UserError("workspace bridge no longer matches its runtime");
  const server = createWorkspaceAgentServer(config, context, async (updated) => {
    await ensureWorkspaceIntegration(updated, context);
    await ensureWorkspaceAgent(updated, context);
  });
  const close = () => { abort.abort(); server.close(); server.closeAllConnections(); };
  process.once("SIGTERM", close); process.once("SIGINT", close); process.once("SIGHUP", close);
  const watch = setInterval(() => { void store.read(config.workspaceName).then((record) => {
    if (record.id !== config.workspaceId) close();
  }, close); }, 2_000);
  const configurationWatch = setInterval(() => { void privateJson(file).then((value) => {
    const latest = parseConfiguration(value);
    if (latest.token !== config.token || latest.host !== config.host || latest.generation !== config.generation) close();
  }, close); }, 2_000);
  try {
    server.listen(0, config.host); await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new UserError("expected a private workspace listener");
    await atomicWrite(path.join(path.dirname(file), "ready.json"), { endpoint: `http://${config.host}:${address.port}`, workspaceId: config.workspaceId });
    await once(server, "close");
  } finally {
    clearInterval(watch); clearInterval(configurationWatch); close();
    process.off("SIGTERM", close); process.off("SIGINT", close); process.off("SIGHUP", close);
  }
}

/** Exported for real HTTP tests with disposable state and a runtime adapter. */
export function createWorkspaceAgentServer(
  config: AgentConfiguration, context: AgentHostContext,
  afterChange?: (record: WorkspaceRecord) => Promise<void>
): Server {
  let changing = false;
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) json(response, error instanceof UserError ? 400 : 503, { error: error instanceof UserError ? error.message : "workspace service unavailable" });
      else response.destroy();
    });
  });
  server.requestTimeout = 15_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 1_000;
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin !== undefined || !authorized(request.headers.authorization, config.token)) { json(response, 403, { error: "workspace connection denied" }); return; }
    response.setHeader("x-dim-bridge-generation", config.generation);
    const record = await context.store.read(config.workspaceName);
    if (record.id !== config.workspaceId) { json(response, 410, { error: "workspace identity expired" }); return; }
    if (request.method === "GET" && request.url === "/v1/resources") { json(response, 200, record.resources); return; }
    if (request.method === "POST" && ["/v1/restart", "/v1/recreate"].includes(request.url ?? "")) {
      const body = await readJson(request);
      if (!isObject(body) || Object.keys(body).length) throw new UserError("restart accepts no workspace selector or options");
      if (changing) { json(response, 409, { error: "workspace operation already in progress" }); return; }
      changing = true;
      const operation = request.url === "/v1/restart" ? "restart" : "recreate";
      json(response, 202, { accepted: true, operation, workspaceId: record.id });
      setImmediate(() => { void context.service[operation](record.name, record.id).then(afterChange).catch((error: unknown) => {
        process.stderr.write(`workspace ${operation}: ${error instanceof Error ? error.message : String(error)}\n`);
      }).finally(() => { changing = false; }); });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/plugins") {
      if (!record.initialized || record.phase !== "running" || !(await context.runtime.inspect(record))?.running) { json(response, 409, { error: "workspace is not running" }); return; }
      const plugins = [], installed = await loadHostPlugins();
      const pluginContext = { ...context, extensions: hostPluginExtensions(installed) };
      for (const plugin of installed) {
        const guest = plugin.guest;
        if (!guest) continue;
        const status = await guest.inspect?.(record, pluginContext) ?? { state: "ready" as const };
        if (!isObject(status) || !["ready", "unconfigured"].includes(status.state)
          || (status.message !== undefined && (typeof status.message !== "string" || status.message.length > 2000))) {
          throw new UserError(`invalid guest integration status from '${plugin.name}'`);
        }
        plugins.push({ name: plugin.name, description: guest.description,
          commands: (guest.commands ?? []).map(({ name, description }) => ({ name, description })),
          operations: (guest.operations ?? []).map(({ name, description }) => ({ name, description })),
          state: status.state, ...(status.message === undefined ? {} : { message: status.message }) });
      }
      const latest = await context.store.read(config.workspaceName);
      if (latest.id !== record.id || !latest.initialized || latest.phase !== "running" || !(await context.runtime.inspect(latest))?.running) { json(response, 410, { error: "workspace identity expired" }); return; }
      json(response, 200, { plugins }); return;
    }
    const operationPath = /^\/v1\/plugins\/([a-z][a-z0-9-]{0,63})\/([a-z][a-z0-9-]{0,63})$/.exec(request.url ?? "");
    if (request.method === "POST" && operationPath) {
      if (!record.initialized || record.phase !== "running" || !(await context.runtime.inspect(record))?.running) { json(response, 409, { error: "workspace is not running" }); return; }
      const installed = await loadHostPlugins();
      const plugin = installed.find(({ name }) => name === operationPath[1]);
      const operation = plugin?.guest?.operations?.find(({ name }) => name === operationPath[2]);
      if (!operation) { json(response, 404, { error: "unknown workspace plugin operation" }); return; }
      const input = await readJson(request);
      const latest = await context.store.read(config.workspaceName);
      if (latest.id !== record.id || !latest.initialized || latest.phase !== "running" || !(await context.runtime.inspect(latest))?.running) { json(response, 410, { error: "workspace identity expired" }); return; }
      json(response, 200, await operation.handle(input, latest, { ...context, extensions: hostPluginExtensions(installed) })); return;
    }
    json(response, 404, { error: "unknown workspace operation" });
  }
  return server;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of request) { const chunk = Buffer.from(raw); size += chunk.length; if (size > 16_384) throw new UserError("workspace request is too large"); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new UserError("invalid workspace request JSON"); }
}
function json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
function authorized(value: string | undefined, token: string): boolean { const expected = Buffer.from(`Bearer ${token}`); const actual = Buffer.from(value ?? ""); return actual.length === expected.length && timingSafeEqual(actual, expected); }
async function privateJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > 16_384) throw new UserError("workspace bridge configuration must be a private owner-only regular file");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}
function parseStoredConfiguration(value: unknown): StoredAgentConfiguration {
  if (!isObject(value) || typeof value.workspaceId !== "string" || !/^[0-9a-f-]{36}$/.test(value.workspaceId)
    || typeof value.workspaceName !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.workspaceName)
    || typeof value.stateRoot !== "string" || !path.isAbsolute(value.stateRoot)
    || typeof value.host !== "string" || !privateAddress(value.host)
    || (value.generation !== undefined && (typeof value.generation !== "string" || !/^[0-9a-f]{64}$/.test(value.generation)))
    || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw new UserError("invalid workspace bridge configuration");
  return { workspaceId: value.workspaceId, workspaceName: value.workspaceName, stateRoot: value.stateRoot, host: value.host, token: value.token, ...(value.generation === undefined ? {} : { generation: value.generation }) };
}
function privateAddress(value: string): boolean { return isIP(value) === 4 && (/^10\./.test(value) || /^192\.168\./.test(value) || /^172\.(?:1[6-9]|2[0-9]|3[01])\./.test(value)); }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hasCode(value: unknown, code: string): boolean { return isObject(value) && value.code === code; }


function parseConfiguration(value: unknown): AgentConfiguration {
  const config = parseStoredConfiguration(value);
  if (!config.generation) throw new UserError("workspace bridge configuration requires a current generation");
  return { ...config, generation: config.generation };
}

/** One shared bridge owns module freshness; plugins need no update callbacks. */
export async function workspaceAgentGeneration(): Promise<string> {
  const hash = createHash("sha256").update("dim-workspace-bridge-v2\0");
  const source = fileURLToPath(import.meta.url);
  for (const file of [source, path.join(path.dirname(source), `host-plugins${path.extname(source)}`)]) {
    hash.update(file).update("\0").update(await readFile(file)).update("\0");
  }
  const home = hostPluginHome(); hash.update(home).update("\0");
  try {
    const metadata = await stat(home, { bigint: true });
    hash.update(`${metadata.dev}:${metadata.ino}\0`);
  } catch (error) { if (!hasCode(error, "ENOENT")) throw error; hash.update("absent\0"); }
  let manifest: string;
  try { manifest = await readFile(path.join(home, "plugins.json"), "utf8"); }
  catch (error) { if (!hasCode(error, "ENOENT")) throw error; return hash.update("no-plugins").digest("hex"); }
  hash.update(manifest).update("\0");
  const value: unknown = JSON.parse(manifest);
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.plugins)
    || !value.plugins.every((name: unknown) => typeof name === "string" && name.length > 0)) throw new UserError("invalid installed DIM plugin manifest");
  const installed = createRequire(path.join(home, "package.json"));
  for (const name of value.plugins as string[]) {
    const file = installed.resolve(name);
    hash.update(name).update("\0").update(file).update("\0").update(await readFile(file)).update("\0");
  }
  return hash.digest("hex");
}
