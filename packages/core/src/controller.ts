import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isUserError, UserError } from "./errors.js";
import { LifecycleState } from "./lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import { ProcessRunner } from "./runner.js";
import type { StreamingCommandRunner } from "./types.js";
import { restartWorkspace as restartWorkspaceLifecycle } from "./workspaceLifecycle.js";

export type ControllerMethod = "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
export type ControllerAudience = "workspace" | "agent";

export interface ControllerWorkspace {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
}

export interface WorkspaceTarget {
  containers: string[];
  port: number;
  protocol: "http" | "https";
}

export interface ResolvedWorkspaceTarget {
  protocol: "http" | "https";
  host: string;
  port: number;
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
  readonly audiences: readonly ControllerAudience[];
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
  restartWorkspace?(workspace: ControllerWorkspace): Promise<void>;
  maxBodyBytes?: number;
}

export function configuredDimController(
  lifecycle: LifecycleOptions,
  plugins: RegisteredDimPlugins,
  runner: StreamingCommandRunner = new ProcessRunner()
): Server {
  const state = new LifecycleState(lifecycle.stateRoot);
  return createDimController({
    stateRoot: lifecycle.stateRoot,
    routes: controllerRoutesForAudience(plugins.controllerRoutes, "workspace"),
    hostInputProviders: plugins.hostInputProviders,
    authenticate: async (token) => {
      const workspace = await state.authenticateWorkspaceGrant(token);
      return workspace && {
        id: `${workspace.projectId}:${workspace.name}`,
        name: workspace.name,
        projectId: workspace.projectId,
        projectName: workspace.projectName
      };
    },
    resolveTarget: async (workspace, target, mode) => {
      const record = await state.readWorkspace(workspace.name);
      if (record.projectId !== workspace.projectId) throw new UserError("workspace identity changed");
      return resolveWorkspaceTarget(runner, record, target, mode);
    },
    restartWorkspace: async (workspace) => {
      const record = await state.readWorkspace(workspace.name);
      if (record.projectId !== workspace.projectId) throw new UserError("workspace identity changed");
      await restartWorkspaceLifecycle(runner, lifecycle, workspace.name);
    }
  });
}

export function configuredDimAgentController(
  lifecycle: LifecycleOptions,
  plugins: RegisteredDimPlugins,
  runner: StreamingCommandRunner = new ProcessRunner()
): Server {
  const state = new LifecycleState(lifecycle.stateRoot);
  return createDimController({
    stateRoot: lifecycle.stateRoot,
    routes: controllerRoutesForAudience(plugins.controllerRoutes, "agent"),
    authenticate: async (token) => {
      const workspace = await state.authenticateAgentGrant(token);
      return workspace && {
        id: `${workspace.projectId}:${workspace.name}`,
        name: workspace.name,
        projectId: workspace.projectId,
        projectName: workspace.projectName
      };
    },
    resolveTarget: async (workspace, target, mode) => {
      const record = await state.readWorkspace(workspace.name);
      if (record.projectId !== workspace.projectId) throw new UserError("workspace identity changed");
      return resolveWorkspaceTarget(runner, record, target, mode);
    }
  });
}

export function controllerRoutesForAudience(
  routes: readonly DimControllerRoute[],
  audience: ControllerAudience
): DimControllerRoute[] {
  return routes.filter((route) => route.audiences.includes(audience));
}

export async function initializeControllerRoutes(
  lifecycle: LifecycleOptions,
  plugins: RegisteredDimPlugins,
  runner: StreamingCommandRunner = new ProcessRunner()
): Promise<void> {
  const state = new LifecycleState(lifecycle.stateRoot);
  const runtime: ControllerRuntimeContext = {
    stateRoot: lifecycle.stateRoot,
    runner,
    listWorkspaces: async () => (await state.listWorkspaces()).map((workspace) => ({
      id: `${workspace.projectId}:${workspace.name}`,
      name: workspace.name,
      projectId: workspace.projectId,
      projectName: workspace.projectName
    })),
    resolveTarget: async (workspace, target, mode) => {
      const record = await state.readWorkspace(workspace.name);
      if (record.projectId !== workspace.projectId) throw new UserError("workspace identity changed");
      return resolveWorkspaceTarget(runner, record, target, mode);
    }
  };
  const initialized = new Set<DimControllerRoute["initialize"]>();
  for (const route of plugins.controllerRoutes) {
    if (!route.initialize || initialized.has(route.initialize)) continue;
    initialized.add(route.initialize);
    await route.initialize(runtime);
  }
}

export function createDimController(options: DimControllerOptions): Server {
  const pendingRestarts = new Set<string>();
  return createServer((request, response) => {
    void handleRequest(options, pendingRestarts, request, response).catch((error) => {
      sendJson(response, isUserError(error) ? 400 : 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
}

async function handleRequest(
  options: DimControllerOptions,
  pendingRestarts: Set<string>,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://dim-controller");
  if (request.method === "GET" && url.pathname === "/healthz") {
    return sendJson(response, 200, { ok: true, apiVersion: 1 });
  }
  const workspace = await authenticate(options, request);
  if (!workspace) return sendJson(response, 401, { error: "invalid workspace grant" });
  if (request.method === "GET" && url.pathname === "/api") {
    return sendJson(response, 200, {
      apiVersion: 1,
      workspace: { name: workspace.name, project: workspace.projectName },
      routes: [
        ...(options.restartWorkspace ? [{
          method: "POST",
          path: "/api/workspace/restart",
          summary: "Restart the authenticated workspace"
        }] : []),
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
  if (request.method === "POST" && url.pathname === "/api/workspace/restart" && options.restartWorkspace) {
    if ((request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")
      || request.headers["transfer-encoding"] !== undefined) {
      throw new UserError("workspace restart request must not include a body");
    }
    if (!pendingRestarts.has(workspace.id)) {
      pendingRestarts.add(workspace.id);
      response.once("finish", () => {
        setImmediate(() => {
          void options.restartWorkspace!(workspace)
            .catch((error) => console.error(`DIM workspace '${workspace.name}' self-restart failed`, error))
            .finally(() => pendingRestarts.delete(workspace.id));
        });
      });
    }
    sendJson(response, 202, { accepted: true, workspace: workspace.name });
    return;
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/host-inputs/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/host-inputs/".length));
    const provider = options.hostInputProviders?.get(name);
    if (!provider) return sendJson(response, 404, { error: "host input provider not found" });
    const body = await readJson(request, options.maxBodyBytes ?? 16_384);
    if (!body || typeof body !== "object" || typeof (body as { key?: unknown }).key !== "string") {
      throw new UserError("host input request requires a string key");
    }
    const parameters = (body as { parameters?: unknown }).parameters;
    if (parameters !== undefined && typeof parameters !== "string") {
      throw new UserError("host input request parameters must be a string");
    }
    const value = await provider.resolve({
      key: (body as { key: string }).key,
      ...(parameters === undefined ? {} : { parameters })
    }, {
      projectId: workspace.projectId,
      projectName: workspace.projectName,
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
      readJson: (limit = options.maxBodyBytes ?? 16_384) => readJson(request, limit),
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

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new UserError("request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new UserError("request body must be valid JSON");
  }
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

export async function resolveWorkspaceTarget(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  target: WorkspaceTarget,
  mode: "container-dns" | "container-ip"
): Promise<ResolvedWorkspaceTarget> {
  validateTarget(target);
  if (target.containers.length === 0) {
    return {
      protocol: target.protocol,
      host: mode === "container-ip"
        ? await outerContainerIp(runner, record)
        : record.containerName,
      port: target.port
    };
  }

  const first = await innerContainer(runner, record, target.containers[0] as string);
  let relayTargetPort = target.port;
  if (target.containers.length === 2) {
    relayTargetPort = await nestedPublishedPort(
      runner,
      record,
      first.name,
      target.containers[1] as string,
      target.port
    );
  }
  const relayPort = 20_000 + stableHash(JSON.stringify(target)) % 30_000;
  await ensureWorkspaceRelay(runner, record, relayPort, first.ip, relayTargetPort);
  return {
    protocol: target.protocol,
    host: mode === "container-ip"
      ? await outerContainerIp(runner, record)
      : record.containerName,
    port: relayPort
  };
}

function validateTarget(target: WorkspaceTarget): void {
  if (!target || typeof target !== "object" || !Array.isArray(target.containers) || target.containers.length > 2) {
    throw new UserError("target.containers must contain zero, one, or two container names");
  }
  if (!target.containers.every((name) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name))) {
    throw new UserError("target container names are invalid");
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535) {
    throw new UserError("target.port must be an integer between 1 and 65535");
  }
  if (target.protocol !== "http" && target.protocol !== "https") {
    throw new UserError("target.protocol must be http or https");
  }
}

async function outerContainerIp(runner: StreamingCommandRunner, record: WorkspaceRecord): Promise<string> {
  const inspected = await runner.run("docker", [
    "container", "inspect", record.containerName,
    "--format", "{{json .NetworkSettings.Networks}}"
  ]);
  if (inspected.exitCode !== 0) throw new UserError(`cannot inspect workspace '${record.name}'`);
  const networks = JSON.parse(inspected.stdout) as Record<string, { IPAddress?: string }>;
  const address = networks[record.networkName]?.IPAddress;
  if (!address) throw new UserError(`workspace '${record.name}' has no address on '${record.networkName}'`);
  return address;
}

async function innerContainer(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  nameOrService: string
): Promise<{ name: string; ip: string }> {
  let inspected = await workspaceDocker(runner, record, [
    "container", "inspect", nameOrService,
    "--format", "{{json .}}"
  ]);
  if (inspected.exitCode !== 0) {
    const found = await workspaceDocker(runner, record, [
      "ps", "--filter", `label=com.docker.compose.project=${record.composeProjectName}`,
      "--filter", `label=com.docker.compose.service=${nameOrService}`,
      "--format", "{{.Names}}"
    ]);
    const names = found.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (found.exitCode !== 0 || names.length !== 1) {
      throw new UserError(`workspace target container '${nameOrService}' was not found uniquely`);
    }
    inspected = await workspaceDocker(runner, record, [
      "container", "inspect", names[0] as string,
      "--format", "{{json .}}"
    ]);
  }
  if (inspected.exitCode !== 0) throw new UserError(`cannot inspect workspace target '${nameOrService}'`);
  const container = JSON.parse(inspected.stdout) as {
    Name?: string;
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
  };
  const ip = Object.values(container.NetworkSettings?.Networks ?? {}).map((network) => network.IPAddress).find(Boolean);
  if (!ip) throw new UserError(`workspace target '${nameOrService}' has no reachable address`);
  return { name: (container.Name ?? nameOrService).replace(/^\//, ""), ip };
}

async function nestedPublishedPort(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  parent: string,
  child: string,
  port: number
): Promise<number> {
  const inspected = await runner.run("docker", [
    "exec", "--user", "root", record.containerName,
    nestedEngine(record), "exec", parent,
    "docker", "container", "inspect", child,
    "--format", "{{json .NetworkSettings.Ports}}"
  ]);
  if (inspected.exitCode !== 0) {
    throw new UserError(`nested target '${parent}/${child}' was not found`);
  }
  const ports = JSON.parse(inspected.stdout) as Record<string, Array<{ HostPort?: string }> | null>;
  const published = ports[`${port}/tcp`]?.[0]?.HostPort;
  const parsed = Number(published);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new UserError(`nested target '${parent}/${child}' must publish TCP port ${port} on '${parent}'`);
  }
  return parsed;
}

async function ensureWorkspaceRelay(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  listenPort: number,
  host: string,
  port: number
): Promise<void> {
  const config = Buffer.from(JSON.stringify({ host, port })).toString("base64");
  const result = await runner.run("docker", [
    "exec", "--user", "root",
    "--env", `DIM_ROUTE_CONFIG_B64=${config}`,
    record.containerName,
    "sh", "-c",
    `mkdir -p /run/dim/routes; printf %s "$DIM_ROUTE_CONFIG_B64" | base64 -d > /run/dim/routes/${listenPort}.json; `
      + `test -s /run/dim/routes/${listenPort}.pid && kill -0 "$(cat /run/dim/routes/${listenPort}.pid)" 2>/dev/null || `
      + `(nohup node /usr/local/lib/dim/route-relay.mjs ${listenPort} /run/dim/routes/${listenPort}.json `
      + `>/run/dim/routes/${listenPort}.log 2>&1 & echo $! > /run/dim/routes/${listenPort}.pid)`
  ]);
  if (result.exitCode !== 0) throw new UserError(`cannot create route relay in workspace '${record.name}'`);
}

async function workspaceDocker(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  args: string[]
) {
  return runner.run("docker", ["exec", "--user", "root", record.containerName, nestedEngine(record), ...args]);
}

function nestedEngine(_record: WorkspaceRecord): "docker" {
  return "docker";
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
