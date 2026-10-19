import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { adminBuiltinCall } from "./adminBuiltin.js";
import { readJson, record } from "./adminInput.js";
import { isUserError, UserError } from "@slop-lab/dim-host-core";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import { ProcessRunner } from "@slop-lab/dim-host-core";
import type { StreamingCommandRunner } from "@slop-lab/dim-host-core";

export const ADMIN_CONTROLLER_STOP_EVENT = "dim-admin-controller-stop";

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
  readonly server: Server;
  readonly lifecycle: LifecycleOptions;
  readonly plugins: RegisteredDimPlugins;
  readonly runner: StreamingCommandRunner;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
};

export function configuredDimAdminController(
  lifecycle: LifecycleOptions,
  plugins: RegisteredDimPlugins,
  runner: StreamingCommandRunner = new ProcessRunner()
): Server {
  const server = createServer((request, response) => {
    void handleAdminRequest({
      server, lifecycle, plugins, runner, request, response
    }).catch((error) => {
      sendJson(response, isUserError(error) ? 400 : 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
  return server;
}

async function handleAdminRequest(context: AdminRequest): Promise<void> {
  const { server, lifecycle, plugins, runner, request, response } = context;
  const url = new URL(request.url ?? "/", "http://dim-admin");
  if (request.method === "GET" && ["/healthz", "/readyz"].includes(url.pathname)) {
    return sendJson(response, 200, { ok: true, ready: true, apiVersion: 1 });
  }
  if (request.method === "POST" && url.pathname === "/v1/controller/stop"
    && request.socket.remoteAddress === undefined) {
    response.once("finish", () => setImmediate(() => server.emit(ADMIN_CONTROLLER_STOP_EVENT)));
    return sendJson(response, 202, { accepted: true });
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
  if (request.method === "POST" && url.pathname.startsWith("/v1/call/")) {
    const operation = decodeURIComponent(url.pathname.slice("/v1/call/".length));
    const body = await readJson(request, 65_536);
    return sendJson(response, 200, await adminBuiltinCall(operation, { input: record(body), lifecycle, runner, plugins }));
  }
  for (const route of plugins.adminRoutes) {
    if (route.method !== request.method) continue;
    const params = matchRoute(route.path, url.pathname);
    if (!params) continue;
    const result = await route.handle({
      params, request, lifecycle, runner,
      readJson: (limit = 65_536) => readJson(request, limit)
    });
    if (!result) return void response.writeHead(204).end();
    if (result.body === undefined) return void response.writeHead(result.status ?? 204).end();
    return sendJson(response, result.status ?? 200, result.body);
  }
  sendJson(response, 404, { error: "not found" });
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
