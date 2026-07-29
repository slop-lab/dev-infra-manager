import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import {
  DIM_PLUGIN_API_VERSION,
  UserError,
  type ControllerRouteContext,
  type ControllerRuntimeContext,
  type ControllerWorkspace,
  type DimPlugin,
  type DimPluginLogger,
  type ResolvedWorkspaceTarget,
  type WorkspaceTarget
} from "@slop-lab/dim-core";
import { readExternalUrlConfig } from "@slop-lab/dim-contracts-external-url";

export interface ExternalUrlIngressOptions {
  description: string;
  scheme: "http" | "https";
  domain: string;
  port?: number;
  listenHost: string;
  listenPort: number;
  upstreamMode?: "container-dns" | "container-ip";
}

export interface ExternalUrlsPluginOptions {
  ingresses: Readonly<Record<string, ExternalUrlIngressOptions>>;
}

interface NormalizedRequest {
  ingress: string;
  service: string;
  target: WorkspaceTarget;
  path?: string;
}

interface ExternalRoute {
  id: string;
  ingress: string;
  authority: string;
  ingressId?: string;
}

interface StoredUrl {
  id: string;
  workspace: string;
  workspaceId: string;
  ingress: string;
  service: string;
  target: WorkspaceTarget;
  path?: string;
  route: ExternalRoute;
  url: string;
  createdAt: string;
}

interface IngressRouter {
  name: string;
  upstreamMode: "container-dns" | "container-ip";
  provision(workspace: ControllerWorkspace, request: NormalizedRequest, upstream: ResolvedWorkspaceTarget): Promise<ExternalRoute>;
  revoke(route: ExternalRoute): Promise<void>;
  close(): Promise<void>;
}

interface ConfiguredIngress {
  options: ExternalUrlIngressOptions;
  router: IngressRouter;
}

interface RouterOptions {
  name: string;
  listenHost: string;
  listenPort: number;
  upstreamMode: "container-dns" | "container-ip";
}

export function createExternalUrlsPlugin(options: ExternalUrlsPluginOptions): DimPlugin {
  validateOptions(options);

  return {
    name: "@slop-lab/dim-plugin-external-urls",
    apiVersion: DIM_PLUGIN_API_VERSION,
    register(host) {
      const ingresses = new Map<string, ConfiguredIngress>();
      for (const [name, ingress] of Object.entries(options.ingresses)) {
        ingresses.set(name, {
          options: ingress,
          router: new WorkspaceIngressRouter({
            name,
            listenHost: ingress.listenHost,
            listenPort: ingress.listenPort,
            upstreamMode: ingress.upstreamMode ?? "container-ip"
          }, host.logger)
        });
      }

      const initialize = async (runtime: ControllerRuntimeContext): Promise<void> => {
        const store = new ExternalUrlStore(runtime.stateRoot);
        for (const workspace of await runtime.listWorkspaces()) {
          for (const entry of deduplicateRoutes(await store.list(workspace.id))) {
            const ingress = required(ingresses, entry.ingress);
            const upstream = await runtime.resolveTarget(workspace, entry.target, ingress.router.upstreamMode);
            const reconciled = await ingress.router.provision(workspace, storedRequest(entry), upstream);
            if (reconciled.authority !== entry.route.authority) {
              throw new Error(`external route '${entry.route.id}' changed authority during reconciliation`);
            }
          }
        }
      };

      const discovery = {
        ingresses: Object.entries(options.ingresses).map(([name, ingress]) => ({
          name,
          description: ingress.description,
          scheme: ingress.scheme
        })),
        target: {
          containers: "zero, one, or two nested container/service names",
          maxDepth: 2
        }
      };
      host.registerControllerRoute({
        method: "GET",
        path: "/urls",
        summary: "List external URLs for this workspace",
        discovery,
        initialize,
        handle: (context) => listUrls(context)
      });
      host.registerControllerRoute({
        method: "POST",
        path: "/urls",
        summary: "Create an external URL using a host-configured ingress",
        discovery,
        handle: (context) => createUrl(context, ingresses)
      });
      host.registerControllerRoute({
        method: "DELETE",
        path: "/urls/:id",
        summary: "Revoke an external URL",
        handle: (context) => deleteUrl(context, ingresses)
      });

      return async () => Promise.all([...ingresses.values()].map((ingress) => ingress.router.close())).then(() => {});
    }
  };
}

export async function externalUrlsPluginFromConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<DimPlugin> {
  const config = await readExternalUrlConfig(env, { required: true });
  return createExternalUrlsPlugin({ ingresses: config.ingresses });
}

async function listUrls(context: ControllerRouteContext) {
  return {
    body: {
      urls: publicEntries(await new ExternalUrlStore(context.stateRoot).list(context.workspace.id))
    }
  };
}

async function createUrl(
  context: ControllerRouteContext,
  ingresses: ReadonlyMap<string, ConfiguredIngress>
) {
  const request = validateRequest(await context.readJson());
  const ingress = required(ingresses, request.ingress);
  const upstream = await context.resolveTarget(request.target, ingress.router.upstreamMode);
  const route = await ingress.router.provision(context.workspace, request, upstream);
  try {
    const url = externalUrl(ingress.options, request, route);
    const entry: StoredUrl = {
      id: randomUUID(),
      workspace: context.workspace.name,
      workspaceId: context.workspace.id,
      ingress: request.ingress,
      service: request.service,
      target: request.target,
      ...(request.path === undefined ? {} : { path: request.path }),
      route,
      url,
      createdAt: new Date().toISOString()
    };
    await new ExternalUrlStore(context.stateRoot).put(entry);
    return { status: 201, body: { urls: [publicEntry(entry)] } };
  } catch (error) {
    await ingress.router.revoke(route).catch(() => {});
    throw error;
  }
}

async function deleteUrl(
  context: ControllerRouteContext,
  ingresses: ReadonlyMap<string, ConfiguredIngress>
) {
  const store = new ExternalUrlStore(context.stateRoot);
  const entries = await store.list(context.workspace.id);
  const entry = entries.find((candidate) => candidate.id === context.params.id);
  if (!entry) return { status: 404, body: { error: "external URL not found" } };
  const ingress = required(ingresses, entry.ingress);
  await store.remove(entry);
  if (!entries.some((candidate) => candidate.id !== entry.id
    && candidate.route.ingress === entry.route.ingress
    && candidate.route.authority === entry.route.authority)) {
    await ingress.router.revoke(entry.route);
  }
  return { status: 204 };
}

class ExternalUrlStore {
  constructor(readonly stateRoot: string) {}

  async list(workspaceId: string): Promise<StoredUrl[]> {
    const directory = this.directory(workspaceId);
    try {
      const names = await readdir(directory);
      return await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
        const value = JSON.parse(await readFile(path.join(directory, name), "utf8")) as unknown;
        const normalized = normalizeStoredUrl(value);
        if (normalized.migrated) await this.put(normalized.entry);
        return normalized.entry;
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async put(entry: StoredUrl): Promise<void> {
    const target = this.entryPath(entry.workspaceId, entry.id);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  async remove(entry: StoredUrl): Promise<void> {
    await rm(this.entryPath(entry.workspaceId, entry.id), { force: true });
  }

  private directory(workspaceId: string): string {
    return path.join(this.stateRoot, "plugins", "external-urls", Buffer.from(workspaceId).toString("base64url"));
  }

  private entryPath(workspaceId: string, id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new UserError("invalid external URL id");
    return path.join(this.directory(workspaceId), `${id}.json`);
  }
}

class WorkspaceIngressRouter implements IngressRouter {
  readonly name: string;
  readonly upstreamMode: "container-dns" | "container-ip";
  readonly #routes = new Map<string, ResolvedWorkspaceTarget>();
  readonly #server: http.Server;
  readonly #ready: Promise<void>;

  constructor(
    options: RouterOptions,
    logger: DimPluginLogger
  ) {
    this.name = options.name;
    this.upstreamMode = options.upstreamMode;
    this.#server = http.createServer((request, response) => this.#proxy(request, response));
    this.#server.on("upgrade", (request, socket, head) => this.#upgrade(request, socket, head));
    this.#ready = new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(options.listenPort, options.listenHost, () => {
        this.#server.off("error", reject);
        logger.info("DIM external URL reverse proxy listening", {
          ingress: options.name,
          host: options.listenHost,
          port: options.listenPort,
          upstreamMode: options.upstreamMode
        });
        resolve();
      });
    });
  }

  async provision(workspace: ControllerWorkspace, request: NormalizedRequest, upstream: ResolvedWorkspaceTarget) {
    await this.#ready;
    const authority = routeLabel(request.service, workspace.name);
    const existing = this.#routes.get(authority);
    if (existing && JSON.stringify(existing) !== JSON.stringify(upstream)) {
      throw new UserError(`external route '${authority}' already targets another service`);
    }
    this.#routes.set(authority, upstream);
    return { id: randomUUID(), ingress: this.name, authority, ingressId: authority };
  }

  async revoke(route: ExternalRoute): Promise<void> {
    this.#routes.delete(route.ingressId ?? route.authority);
  }

  async close(): Promise<void> {
    await this.#ready.catch(() => {});
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error ? reject(error) : resolve());
    });
  }

  #target(request: IncomingMessage): ResolvedWorkspaceTarget | undefined {
    const hostname = (request.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
    return this.#routes.get(hostname.split(".")[0] ?? "");
  }

  #proxy(request: IncomingMessage, response: ServerResponse): void {
    const target = this.#target(request);
    if (!target) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"external route not found"}\n');
      return;
    }
    const transport = target.protocol === "https" ? https : http;
    const upstream = transport.request({
      hostname: target.host,
      port: target.port,
      method: request.method,
      path: request.url ?? "/",
      headers: {
        ...request.headers,
        host: `${target.host}:${target.port}`,
        "x-forwarded-host": request.headers.host ?? "",
        "x-forwarded-proto": request.headers["x-forwarded-proto"] ?? "http"
      }
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  }

  #upgrade(request: IncomingMessage, client: import("node:stream").Duplex, head: Buffer): void {
    const target = this.#target(request);
    if (!target) {
      client.destroy();
      return;
    }
    const connect = target.protocol === "https"
      ? () => tls.connect(target.port, target.host)
      : () => net.connect(target.port, target.host);
    const upstream = connect();
    upstream.once("connect", () => {
      const headers = Object.entries(request.headers)
        .flatMap(([name, value]) => Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value ?? ""}`]);
      upstream.write(`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
  }
}

function externalUrl(
  ingress: ExternalUrlIngressOptions,
  request: NormalizedRequest,
  route: ExternalRoute
): string {
  const authority = `${route.authority}.${normalizeDomain(ingress.domain)}${
    ingress.port === undefined ? "" : `:${ingress.port}`
  }`;
  return validateExternalUrl(`${ingress.scheme}://${authority}${request.path ?? "/"}`);
}

function validateRequest(value: unknown): NormalizedRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("request body must be an object");
  const input = value as Record<string, unknown>;
  if (typeof input.ingress !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.ingress)) {
    throw new UserError("ingress must be a configured ingress name");
  }
  if (typeof input.service !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.service)) {
    throw new UserError("service must be a DNS label");
  }
  if (!input.target || typeof input.target !== "object" || Array.isArray(input.target)) {
    throw new UserError("target must be an object");
  }
  const target = input.target as Record<string, unknown>;
  const containers = target.containers ?? [];
  if (!Array.isArray(containers) || containers.length > 2 || !containers.every((name) => typeof name === "string")) {
    throw new UserError("target.containers must contain zero, one, or two names");
  }
  if (!Number.isInteger(target.port) || (target.port as number) < 1 || (target.port as number) > 65_535) {
    throw new UserError("target.port must be an integer between 1 and 65535");
  }
  if (target.protocol !== undefined && target.protocol !== "http" && target.protocol !== "https") {
    throw new UserError("target.protocol must be http or https");
  }
  if (input.path !== undefined && (typeof input.path !== "string" || !input.path.startsWith("/") || input.path.includes(".."))) {
    throw new UserError("path must be an absolute URL path without '..'");
  }
  return {
    ingress: input.ingress,
    service: input.service,
    target: {
      containers: containers as string[],
      port: target.port as number,
      protocol: (target.protocol ?? "http") as "http" | "https"
    },
    ...(input.path === undefined ? {} : { path: input.path as string })
  };
}

function validateOptions(options: ExternalUrlsPluginOptions): void {
  const entries = Object.entries(options.ingresses);
  if (entries.length === 0) throw new Error("at least one external URL ingress must be configured");
  for (const [name, ingress] of entries) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error(`invalid external URL ingress '${name}'`);
    if (typeof ingress.description !== "string" || ingress.description.trim().length === 0) {
      throw new Error(`external URL ingress '${name}' requires a description`);
    }
    if (ingress.scheme !== "http" && ingress.scheme !== "https") {
      throw new Error(`external URL ingress '${name}' scheme must be http or https`);
    }
    if (typeof ingress.domain !== "string" || normalizeDomain(ingress.domain).length === 0) {
      throw new Error(`external URL ingress '${name}' requires a domain`);
    }
    if (!Number.isInteger(ingress.listenPort) || ingress.listenPort < 0 || ingress.listenPort > 65_535) {
      throw new Error(`external URL ingress '${name}' listenPort must be between 0 and 65535`);
    }
    if (ingress.port !== undefined
      && (!Number.isInteger(ingress.port) || ingress.port < 1 || ingress.port > 65_535)) {
      throw new Error(`external URL ingress '${name}' port must be between 1 and 65535`);
    }
    if (ingress.upstreamMode !== undefined) upstreamMode(ingress.upstreamMode);
  }
}

function required<T>(values: ReadonlyMap<string, T>, name: string): T {
  const value = values.get(name);
  if (!value) throw new UserError(`external URL ingress '${name}' is not configured`);
  return value;
}

function publicEntries(entries: StoredUrl[]) {
  return entries.map(publicEntry);
}

function publicEntry({ route: _route, workspaceId: _workspaceId, ...entry }: StoredUrl) {
  return entry;
}

function deduplicateRoutes(entries: StoredUrl[]): StoredUrl[] {
  return [...new Map(entries.map((entry) => [entry.route.id, entry])).values()];
}

function storedRequest(entry: StoredUrl): NormalizedRequest {
  return {
    ingress: entry.ingress,
    service: entry.service,
    target: entry.target,
    ...(entry.path === undefined ? {} : { path: entry.path })
  };
}

function normalizeStoredUrl(value: unknown): { entry: StoredUrl; migrated: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid stored external URL");
  }
  const candidate = value as StoredUrl & {
    profile?: string;
    urlProvider?: string;
    route: ExternalRoute & { provider?: string; providerId?: string };
  };
  const ingress = candidate.ingress ?? candidate.profile;
  if (!ingress) throw new Error(`stored external URL '${candidate.id}' has no ingress`);
  const routeIngress = candidate.route.ingress ?? candidate.route.provider ?? ingress;
  const entry: StoredUrl = {
    id: candidate.id,
    workspace: candidate.workspace,
    workspaceId: candidate.workspaceId,
    ingress,
    service: candidate.service,
    target: candidate.target,
    ...(candidate.path === undefined ? {} : { path: candidate.path }),
    route: {
      id: candidate.route.id,
      ingress: routeIngress,
      authority: candidate.route.authority,
      ...(candidate.route.ingressId ?? candidate.route.providerId
        ? { ingressId: candidate.route.ingressId ?? candidate.route.providerId }
        : {})
    },
    url: candidate.url,
    createdAt: candidate.createdAt
  };
  return {
    entry,
    migrated: candidate.ingress === undefined
      || candidate.route.ingress === undefined
      || candidate.profile !== undefined
      || candidate.urlProvider !== undefined
  };
}

function validateExternalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UserError("provider returned a non-HTTP URL");
  if (url.username || url.password) throw new UserError("provider returned a URL containing credentials");
  return url.href;
}

function routeLabel(service: string, workspace: string): string {
  const value = `${service}--${workspace}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (value.length <= 63) return value;
  return `${value.slice(0, 54)}-${stableHash(value).toString(16).padStart(8, "0")}`;
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeDomain(value: string): string {
  return value.toLowerCase().replace(/^\.+|\.+$/g, "");
}

function upstreamMode(value: string): "container-dns" | "container-ip" {
  if (value !== "container-dns" && value !== "container-ip") {
    throw new Error("proxy upstream mode must be container-dns or container-ip");
  }
  return value;
}

const plugin: DimPlugin = {
  name: "@slop-lab/dim-plugin-external-urls",
  apiVersion: DIM_PLUGIN_API_VERSION,
  async register(host) {
    return (await externalUrlsPluginFromConfig()).register(host);
  }
};

export default plugin;
