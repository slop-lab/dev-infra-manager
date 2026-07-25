import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { UserError } from "./errors.js";
import { LifecycleState } from "./lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import { ProcessRunner } from "./runner.js";
import type { StreamingCommandRunner } from "./types.js";

export type ControllerMethod = "GET" | "POST" | "DELETE" | "PUT" | "PATCH";

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
  readonly discovery?: Readonly<Record<string, unknown>>;
  readonly plugin?: string;
  initialize?(context: ControllerRuntimeContext): Promise<void>;
  handle(context: ControllerRouteContext): Promise<ControllerRouteResponse | void>;
}

export interface ControllerRuntimeContext {
  readonly stateRoot: string;
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
  authenticate(token: string): Promise<ControllerWorkspace | undefined>;
  resolveTarget(
    workspace: ControllerWorkspace,
    target: WorkspaceTarget,
    mode: "container-dns" | "container-ip"
  ): Promise<ResolvedWorkspaceTarget>;
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
    routes: plugins.controllerRoutes,
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
    }
  });
}

export async function initializeControllerRoutes(
  lifecycle: LifecycleOptions,
  plugins: RegisteredDimPlugins,
  runner: StreamingCommandRunner = new ProcessRunner()
): Promise<void> {
  const state = new LifecycleState(lifecycle.stateRoot);
  const runtime: ControllerRuntimeContext = {
    stateRoot: lifecycle.stateRoot,
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
  return createServer((request, response) => {
    void handleRequest(options, request, response).catch((error) => {
      sendJson(response, error instanceof UserError ? 400 : 500, {
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
  const workspace = await authenticate(options, request);
  if (!workspace) return sendJson(response, 401, { error: "invalid workspace grant" });
  const url = new URL(request.url ?? "/", "http://dim-controller");
  if (request.method === "GET" && url.pathname === "/api") {
    return sendJson(response, 200, {
      apiVersion: 1,
      workspace: { name: workspace.name, project: workspace.projectName },
      routes: options.routes.map(({ method, path, summary, discovery, plugin }) => ({
        method,
        path: `/api${path}`,
        summary,
        ...(plugin ? { plugin } : {}),
        ...(discovery ? { discovery } : {})
      }))
    });
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

function nestedEngine(record: WorkspaceRecord): "docker" | "podman" {
  return record.runtimeBackend === "rootless-podman" ? "podman" : "docker";
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
