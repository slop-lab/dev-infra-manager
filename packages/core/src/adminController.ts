import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { adminBuiltinCall, STREAMABLE_OPERATIONS } from "./adminBuiltin.js";
import { readJson, record, requiredString, terminalSize } from "./adminInput.js";
import { CommandSessionManager, type CommandSessionEvent } from "./commandSessions.js";
import { isUserError, UserError } from "./errors.js";
import { HostNotReadyError, withHostAdminAdmission } from "./hostAdminAdmission.js";
import { hostLifecycleStatus } from "./hostLifecycle.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import { ProcessRunner } from "./runner.js";
import type { StreamingCommandRunner } from "./types.js";

export interface AdminRouteContext {
  readonly params: Readonly<Record<string, string>>;
  readonly request: IncomingMessage;
  readonly lifecycle: LifecycleOptions;
  readonly runner: StreamingCommandRunner;
  readJson(maxBytes?: number): Promise<unknown>;
}

export interface DimAdminRoute {
  readonly method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  readonly path: string;
  readonly summary: string;
  readonly plugin?: string;
  handle(context: AdminRouteContext): Promise<{ status?: number; body?: unknown } | void>;
}

type AdminRequest = {
  readonly lifecycle: LifecycleOptions;
  readonly plugins: RegisteredDimPlugins;
  readonly runner: StreamingCommandRunner;
  readonly sessions: CommandSessionManager;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
};

export function configuredDimAdminController(
  lifecycle: LifecycleOptions,
  plugins: RegisteredDimPlugins,
  runner: StreamingCommandRunner = new ProcessRunner()
): Server {
  const sessions = new CommandSessionManager(runner);
  return createServer((request, response) => {
    void handleAdminRequest({ lifecycle, plugins, runner, sessions, request, response }).catch((error) => {
      sendJson(response, isUserError(error) ? 400 : 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
}

async function handleAdminRequest(context: AdminRequest): Promise<void> {
  const { lifecycle, plugins, runner, sessions, request, response } = context;
  const url = new URL(request.url ?? "/", "http://dim-admin");
  if (request.method === "GET" && url.pathname === "/healthz") {
    const host = await hostLifecycleStatus(lifecycle);
    return sendJson(response, 200, { ok: true, ready: host.phase === "ready", hostPhase: host.phase, apiVersion: 1 });
  }
  if (request.method === "GET" && url.pathname === "/readyz") {
    const host = await hostLifecycleStatus(lifecycle);
    return sendJson(response, host.phase === "ready" ? 200 : 503, {
      ready: host.phase === "ready",
      hostPhase: host.phase,
      ...(host.error === undefined ? {} : { error: host.error }),
      apiVersion: 1
    });
  }
  if (request.method === "GET" && url.pathname === "/v1") {
    return sendJson(response, 200, {
      apiVersion: 1,
      routes: plugins.adminRoutes.map(({ method, path, summary, plugin }) => ({
        method,
        path: `/v1${path}`,
        summary,
        ...(plugin ? { plugin } : {})
      }))
    });
  }
  if (request.method === "POST" && url.pathname === "/v1/sessions") {
    const input = record(await readJson(request, 65_536));
    const operation = requiredString(input.operation, "operation");
    if (!STREAMABLE_OPERATIONS.has(operation)) throw new UserError(`operation '${operation}' is not streamable`);
    const body = input.input === undefined ? {} : record(input.input);
    const id = sessions.start(
      (sessionRunner) => adminBuiltinCall(operation, { input: body, lifecycle, runner: sessionRunner, plugins }),
      terminalSize(body.terminal)
    );
    return sendJson(response, 202, { id });
  }
  const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(events|input))?$/);
  if (sessionMatch) {
    const encodedId = sessionMatch[1];
    if (encodedId === undefined) return sendJson(response, 404, { error: "not found" });
    const id = decodeURIComponent(encodedId);
    const action = sessionMatch[2];
    if (request.method === "GET" && action === "events") {
      return sendSessionEvents(response, sessions, id);
    }
    if (request.method === "POST" && action === "input") {
      const input = record(await readJson(request, 1_048_576));
      if (input.resize !== undefined) {
        if (!sessions.resize(id, terminalSize(input.resize))) {
          return sendJson(response, 404, { error: "command session not found or complete" });
        }
        return void response.writeHead(204).end();
      }
      if (typeof input.data !== "string") throw new UserError("data must be a string");
      const encoded = input.data;
      if (!sessions.input(id, Buffer.from(encoded, "base64"), input.end === true)) {
        return sendJson(response, 404, { error: "command session not found or complete" });
      }
      return void response.writeHead(204).end();
    }
    if (request.method === "DELETE" && action === undefined) {
      if (!sessions.cancel(id)) return sendJson(response, 404, { error: "command session not found or complete" });
      return void response.writeHead(204).end();
    }
  }
  if (request.method === "POST" && url.pathname.startsWith("/v1/call/")) {
    const operation = decodeURIComponent(url.pathname.slice("/v1/call/".length));
    const body = await readJson(request, 65_536);
    return sendJson(response, 200, await adminBuiltinCall(operation, {
      input: record(body), lifecycle, runner, plugins
    }));
  }
  for (const route of plugins.adminRoutes) {
    if (route.method !== request.method) continue;
    const params = matchRoute(route.path, url.pathname);
    if (!params) continue;
    let result;
    try {
      result = await withHostAdminAdmission(lifecycle, () => route.handle({
        params,
        request,
        lifecycle,
        runner,
        readJson: (limit = 65_536) => readJson(request, limit)
      }));
    } catch (error) {
      if (error instanceof HostNotReadyError) return sendJson(response, 503, { error: error.message });
      throw error;
    }
    if (!result) return void response.writeHead(204).end();
    if (result.body === undefined) return void response.writeHead(result.status ?? 204).end();
    return sendJson(response, result.status ?? 200, result.body);
  }
  sendJson(response, 404, { error: "not found" });
}

function sendSessionEvents(
  response: ServerResponse,
  sessions: CommandSessionManager,
  id: string
): void {
  const write = (event: CommandSessionEvent) => {
    response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (event.type === "result" || event.type === "error") response.end();
  };
  const unsubscribe = sessions.subscribe(id, write);
  const snapshot = sessions.snapshot(id);
  if (!unsubscribe || !snapshot) return sendJson(response, 404, { error: "command session not found" });
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  for (const event of snapshot.events) write(event);
  if (snapshot.complete && !response.writableEnded) response.end();
  response.on("close", unsubscribe);
}

function matchRoute(routePath: string, requestPath: string): Record<string, string> | undefined {
  const expected = `/v1${routePath}`.split("/");
  const actual = requestPath.split("/");
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const part = expected[index] ?? "";
    const value = actual[index] ?? "";
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(value);
    else if (part !== value) return undefined;
  }
  return params;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}
