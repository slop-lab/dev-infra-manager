import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isUserError, UserError, ProcessRunner, type StreamingCommandRunner } from "@slop-lab/dim-core";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import { bufferControllerRequestBody, parseControllerJsonBody } from "./controllerRequestBody.js";
import { ControllerWorkspaces } from "./controllerWorkspace.js";

export type ControllerMethod = "GET" | "POST" | "DELETE" | "PUT" | "PATCH";

export interface ControllerWorkspace {
  id: string;
  name: string;
  projectId?: string;
  projectName?: string;
}

export interface WorkspaceTarget {
  containers: string[];
  port: number;
  protocol: "http" | "https" | "tcp";
}

export interface ResolvedWorkspaceTarget {
  readonly protocol: "http" | "https" | "tcp";
  readonly host: string;
  readonly port: number;
  readonly fingerprint: string;
}

export interface ControllerRouteResponse {
  status?: number;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
}

export interface ControllerRouteContext {
  readonly workspace: ControllerWorkspace;
  readonly params: Readonly<Record<string, string>>;
  readonly request: IncomingMessage;
  readonly stateRoot: string;
  readJson(maxBytes?: number): Promise<unknown>;
  resolveTarget(target: WorkspaceTarget, mode: "container-dns" | "container-ip"): Promise<ResolvedWorkspaceTarget>;
}

export interface DimControllerRoute {
  readonly method: ControllerMethod;
  readonly path: string;
  readonly summary: string;
  readonly discovery?: Readonly<Record<string, unknown>>;
  readonly plugin?: string;
  initialize?(context: ControllerRuntimeContext): Promise<void>;
  handle(context: ControllerRouteContext): Promise<ControllerRouteResponse | void>;
}

export interface ControllerRuntimeContext {
  readonly stateRoot: string;
  readonly runner: StreamingCommandRunner;
  listWorkspaces(): Promise<ControllerWorkspace[]>;
  resolveTarget(
    workspace: ControllerWorkspace,
    target: WorkspaceTarget,
    mode: "container-dns" | "container-ip"
  ): Promise<ResolvedWorkspaceTarget>;
  runWorkspaceRequest<T>(workspace: ControllerWorkspace, operation: () => Promise<T>): Promise<T>;
}

export interface DimControllerOptions {
  stateRoot: string;
  routes: readonly DimControllerRoute[];
  hostInputProviders?: RegisteredDimPlugins["hostInputProviders"];
  authenticate(token: string): Promise<ControllerWorkspace | undefined>;
  resolveTarget(
    workspace: ControllerWorkspace,
    target: WorkspaceTarget,
    mode: "container-dns" | "container-ip"
  ): Promise<ResolvedWorkspaceTarget>;
  runWorkspaceRequest<T>(workspace: ControllerWorkspace, operation: () => Promise<T>): Promise<T>;
  maxBodyBytes?: number;
}

/** Optional host-side plugin API; it never owns workspace lifecycle. */
export function configuredDimController(
  lifecycle: LifecycleOptions,
  plugins: RegisteredDimPlugins,
  runner: StreamingCommandRunner = new ProcessRunner()
): Server {
  const workspaces = new ControllerWorkspaces(lifecycle, runner);
  return createDimController({
    stateRoot: lifecycle.stateRoot,
    routes: plugins.controllerRoutes,
    hostInputProviders: plugins.hostInputProviders,
    authenticate: (token) => workspaces.authenticate(token),
    runWorkspaceRequest: (workspace, operation) => workspaces.run(workspace, operation),
    resolveTarget: (workspace, target, mode) => workspaces.resolveTarget(workspace, target, mode)
  });
}

export async function initializeControllerRoutes(
  lifecycle: LifecycleOptions,
  plugins: RegisteredDimPlugins,
  runner: StreamingCommandRunner = new ProcessRunner()
): Promise<void> {
  const workspaces = new ControllerWorkspaces(lifecycle, runner);
  const runtime: ControllerRuntimeContext = {
    stateRoot: lifecycle.stateRoot, runner,
    listWorkspaces: () => workspaces.list(),
    runWorkspaceRequest: (workspace, operation) => workspaces.run(workspace, operation),
    resolveTarget: (workspace, target, mode) => workspaces.resolveTarget(workspace, target, mode)
  };
  const initialized = new Set<DimControllerRoute["initialize"]>();
  for (const route of plugins.controllerRoutes) {
    if (!route.initialize || initialized.has(route.initialize)) continue;
    initialized.add(route.initialize);
    await route.initialize(runtime);
  }
}

export function createDimController(options: DimControllerOptions): Server {
  return createServer((request, response) => {
    void handleRequest(options, request, response).catch((error) => {
      sendJson(response, isUserError(error) ? 400 : 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
}

async function handleRequest(
  options: DimControllerOptions,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://dim-controller");
  if (request.method === "GET" && url.pathname === "/healthz") {
    return sendJson(response, 200, { ok: true, ready: true, apiVersion: 1 });
  }
  const workspace = await authenticate(options, request);
  if (!workspace) return sendJson(response, 401, { error: "invalid workspace grant" });
  const body = await bufferControllerRequestBody(request, options.maxBodyBytes ?? 16_384);
  return options.runWorkspaceRequest(
    workspace,
    () => handleAuthenticatedRequest(options, request, response, url, workspace, body)
  );
}

async function handleAuthenticatedRequest(
  options: DimControllerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  workspace: ControllerWorkspace,
  body: Buffer
): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api") {
    return sendJson(response, 200, {
      apiVersion: 1,
      workspace: { name: workspace.name, project: workspace.projectName },
      routes: [
        ...options.routes.map(({ method, path, summary, discovery, plugin }) => ({
          method,
          path: `/api${path}`,
          summary,
          ...(plugin ? { plugin } : {}),
          ...(discovery ? { discovery } : {})
        }))
      ],
      hostInputProviders: [...(options.hostInputProviders?.keys() ?? [])]
    });
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/host-inputs/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/host-inputs/".length));
    const provider = options.hostInputProviders?.get(name);
    if (!provider) return sendJson(response, 404, { error: "host input provider not found" });
    const input = parseControllerJsonBody(body, options.maxBodyBytes ?? 16_384);
    if (!input || typeof input !== "object" || typeof (input as { key?: unknown }).key !== "string") {
      throw new UserError("host input request requires a string key");
    }
    const parameters = (input as { parameters?: unknown }).parameters;
    if (parameters !== undefined && typeof parameters !== "string") {
      throw new UserError("host input request parameters must be a string");
    }
    const value = await provider.resolve({
      key: (input as { key: string }).key,
      ...(parameters === undefined ? {} : { parameters })
    }, {
      ...(workspace.projectId === undefined ? {} : { projectId: workspace.projectId }),
      ...(workspace.projectName === undefined ? {} : { projectName: workspace.projectName }),
      workspaceName: workspace.name
    });
    return sendJson(response, 200, { value });
  }

  for (const route of options.routes) {
    if (route.method !== request.method) continue;
    const params = matchRoute(route.path, url.pathname);
    if (!params) continue;
    const result = await route.handle({
      workspace,
      params,
      request,
      stateRoot: options.stateRoot,
      readJson: async (limit = options.maxBodyBytes ?? 16_384) => parseControllerJsonBody(body, limit),
      resolveTarget: (target, mode) => options.resolveTarget(workspace, target, mode)
    });
    if (!result) {
      response.writeHead(204).end();
      return;
    }
    const status = result.status ?? 200;
    if (result.body === undefined) {
      response.writeHead(status, result.headers).end();
      return;
    }
    sendJson(response, status, result.body, result.headers);
    return;
  }
  sendJson(response, 404, { error: "not found" });
}

function matchRoute(path: string, requestPath: string): Record<string, string> | undefined {
  const routeParts = `/api${path}`.split("/");
  const requestParts = requestPath.split("/");
  if (routeParts.length !== requestParts.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < routeParts.length; index += 1) {
    const expected = routeParts[index] ?? "";
    const actual = requestParts[index] ?? "";
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return undefined;
    }
  }
  return params;
}

async function authenticate(options: DimControllerOptions, request: IncomingMessage): Promise<ControllerWorkspace | undefined> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return options.authenticate(header.slice("Bearer ".length));
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {}
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(`${JSON.stringify(body)}\n`);
}
