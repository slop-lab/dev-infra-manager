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
} from "@slop-lab/dev-infra-manager-core";

export interface ReverseProxyOptions {
  name?: string;
  listenHost: string;
  listenPort: number;
  upstreamMode?: "container-dns" | "container-ip";
}

export interface UrlProviderOptions {
  domain: string;
  scheme?: "http" | "https";
  port?: number;
}

export interface TailscaleUrlProviderOptions extends UrlProviderOptions {
  machine: string;
}

export interface ExternalUrlProfile {
  description: string;
  protocol: "http" | "https";
}

export interface ExternalUrlProfileBinding {
  routeProvider: string;
  urlProvider: string;
}

export interface ExternalUrlsPluginOptions {
  proxies?: ReverseProxyOptions[];
  listenHost?: string;
  listenPort?: number;
  upstreamMode?: "container-dns" | "container-ip";
  tailscale?: TailscaleUrlProviderOptions;
  cloudflare?: UrlProviderOptions;
  profiles?: Readonly<Record<string, ExternalUrlProfile>>;
  bindings?: Readonly<Record<string, ExternalUrlProfileBinding>>;
}

interface NormalizedRequest {
  profile: string;
  service: string;
  target: WorkspaceTarget;
  path?: string;
}

interface ExternalRoute {
  id: string;
  provider: string;
  authority: string;
  providerId?: string;
}

interface StoredUrl {
  id: string;
  workspace: string;
  workspaceId: string;
  profile: string;
  urlProvider: string;
  service: string;
  target: WorkspaceTarget;
  path?: string;
  route: ExternalRoute;
  url: string;
  createdAt: string;
}

interface RouteProvider {
  name: string;
  upstreamMode: "container-dns" | "container-ip";
  provision(workspace: ControllerWorkspace, request: NormalizedRequest, upstream: ResolvedWorkspaceTarget): Promise<ExternalRoute>;
  revoke(route: ExternalRoute): Promise<void>;
  close(): Promise<void>;
}

interface UrlProvider {
  name: string;
  publish(workspace: ControllerWorkspace, request: NormalizedRequest, route: ExternalRoute): Promise<string>;
  revoke(entry: StoredUrl): Promise<void>;
}

export function createExternalUrlsPlugin(options: ExternalUrlsPluginOptions): DimPlugin {
  const proxyOptions = normalizeProxies(options);
  const { profiles, bindings } = normalizeProfileConfiguration(options, proxyOptions);
  validateOptions(options, proxyOptions, profiles, bindings);

  return {
    name: "@slop-lab/dim-plugin-external-urls",
    apiVersion: DIM_PLUGIN_API_VERSION,
    register(host) {
      const routes = new Map<string, RouteProvider>();
      for (const proxy of proxyOptions) {
        routes.set(proxy.name, new WorkspaceReverseProxy(proxy, host.logger));
      }
      const urls = new Map<string, UrlProvider>();
      if (options.tailscale) {
        urls.set("tailscale", domainProvider("tailscale", options.tailscale.domain, {
          machine: options.tailscale.machine,
          scheme: options.tailscale.scheme ?? "https",
          ...(options.tailscale.port === undefined ? {} : { port: options.tailscale.port })
        }));
      }
      if (options.cloudflare) {
        urls.set("cloudflare", domainProvider("cloudflare", options.cloudflare.domain, {
          scheme: options.cloudflare.scheme ?? "https",
          ...(options.cloudflare.port === undefined ? {} : { port: options.cloudflare.port })
        }));
      }

      const initialize = async (runtime: ControllerRuntimeContext): Promise<void> => {
        const store = new ExternalUrlStore(runtime.stateRoot);
        for (const workspace of await runtime.listWorkspaces()) {
          for (const entry of deduplicateRoutes(await store.list(workspace.id))) {
            const binding = bindings[entry.profile];
            if (!binding) throw new Error(`external URL profile '${entry.profile}' is no longer configured`);
            const routeProvider = required(routes, binding.routeProvider, "route");
            const upstream = await runtime.resolveTarget(workspace, entry.target, routeProvider.upstreamMode);
            const reconciled = await routeProvider.provision(workspace, storedRequest(entry), upstream);
            if (reconciled.authority !== entry.route.authority) {
              throw new Error(`external route '${entry.route.id}' changed authority during reconciliation`);
            }
          }
        }
      };

      const discovery = {
        profiles: Object.entries(profiles).map(([name, profile]) => ({
          name,
          description: profile.description,
          protocol: profile.protocol
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
        summary: "Create an external URL using a host-configured profile",
        discovery,
        handle: (context) => createUrl(context, profiles, bindings, routes, urls)
      });
      host.registerControllerRoute({
        method: "DELETE",
        path: "/urls/:id",
        summary: "Revoke an external URL",
        handle: (context) => deleteUrl(context, routes, urls)
      });

      return async () => Promise.all([...routes.values()].map((proxy) => proxy.close())).then(() => {});
    }
  };
}

export function externalUrlsPluginFromEnv(env: NodeJS.ProcessEnv = process.env): DimPlugin {
  const configuredProxies = env.DIM_EXTERNAL_URL_PROXIES
    ? parseProxyOptions(env.DIM_EXTERNAL_URL_PROXIES)
    : undefined;
  return createExternalUrlsPlugin({
    ...(configuredProxies
      ? { proxies: configuredProxies }
      : {
          listenHost: env.DIM_EXTERNAL_URL_PROXY_HOST ?? "0.0.0.0",
          listenPort: Number(env.DIM_EXTERNAL_URL_PROXY_PORT ?? "8080"),
          ...(env.DIM_EXTERNAL_URL_PROXY_UPSTREAM_MODE
            ? { upstreamMode: upstreamMode(env.DIM_EXTERNAL_URL_PROXY_UPSTREAM_MODE) }
            : {})
        }),
    ...(env.DIM_TAILSCALE_DOMAIN && env.DIM_TAILSCALE_MACHINE
      ? {
          tailscale: {
            domain: env.DIM_TAILSCALE_DOMAIN,
            machine: env.DIM_TAILSCALE_MACHINE,
            ...(env.DIM_TAILSCALE_SCHEME ? { scheme: scheme(env.DIM_TAILSCALE_SCHEME) } : {}),
            ...(env.DIM_TAILSCALE_PORT ? { port: Number(env.DIM_TAILSCALE_PORT) } : {})
          }
        }
      : {}),
    ...(env.DIM_CLOUDFLARE_DOMAIN
      ? {
          cloudflare: {
            domain: env.DIM_CLOUDFLARE_DOMAIN,
            ...(env.DIM_CLOUDFLARE_SCHEME ? { scheme: scheme(env.DIM_CLOUDFLARE_SCHEME) } : {}),
            ...(env.DIM_CLOUDFLARE_PORT ? { port: Number(env.DIM_CLOUDFLARE_PORT) } : {})
          }
        }
      : {}),
    ...(env.DIM_EXTERNAL_URL_PROFILES
      ? { profiles: parseProfiles(env.DIM_EXTERNAL_URL_PROFILES) }
      : {}),
    ...(env.DIM_EXTERNAL_URL_BINDINGS
      ? { bindings: parseBindings(env.DIM_EXTERNAL_URL_BINDINGS) }
      : {})
  });
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
  profiles: Readonly<Record<string, ExternalUrlProfile>>,
  bindings: Readonly<Record<string, ExternalUrlProfileBinding>>,
  routes: ReadonlyMap<string, RouteProvider>,
  urls: ReadonlyMap<string, UrlProvider>
) {
  const request = validateRequest(await context.readJson());
  const profile = profiles[request.profile];
  if (!profile) throw new UserError(`external URL profile '${request.profile}' is not configured`);
  const binding = bindings[request.profile];
  if (!binding) throw new UserError(`external URL profile '${request.profile}' has no provider binding`);
  const routeProvider = required(routes, binding.routeProvider, "route");
  const urlProvider = required(urls, binding.urlProvider, "URL");
  const upstream = await context.resolveTarget(request.target, routeProvider.upstreamMode);
  const route = await routeProvider.provision(context.workspace, request, upstream);
  let entry: StoredUrl | undefined;
  try {
    const url = validateExternalUrl(await urlProvider.publish(context.workspace, request, route));
    entry = {
      id: randomUUID(),
      workspace: context.workspace.name,
      workspaceId: context.workspace.id,
      profile: request.profile,
      urlProvider: urlProvider.name,
      service: request.service,
      target: request.target,
      ...(request.path === undefined ? {} : { path: request.path }),
      route,
      url,
      createdAt: new Date().toISOString()
    };
    const created = entry;
    await new ExternalUrlStore(context.stateRoot).put(created);
    return { status: 201, body: { urls: [publicEntry(created)] } };
  } catch (error) {
    if (entry) await urlProvider.revoke(entry).catch(() => {});
    await routeProvider.revoke(route).catch(() => {});
    throw error;
  }
}

async function deleteUrl(
  context: ControllerRouteContext,
  routes: ReadonlyMap<string, RouteProvider>,
  urls: ReadonlyMap<string, UrlProvider>
) {
  const store = new ExternalUrlStore(context.stateRoot);
  const entries = await store.list(context.workspace.id);
  const entry = entries.find((candidate) => candidate.id === context.params.id);
  if (!entry) return { status: 404, body: { error: "external URL not found" } };
  const urlProvider = required(urls, entry.urlProvider, "URL");
  await urlProvider.revoke(entry);
  await store.remove(entry);
  if (!entries.some((candidate) => candidate.id !== entry.id
    && candidate.route.provider === entry.route.provider
    && candidate.route.authority === entry.route.authority)) {
    await required(routes, entry.route.provider, "route").revoke(entry.route);
  }
  return { status: 204 };
}

class ExternalUrlStore {
  constructor(readonly stateRoot: string) {}

  async list(workspaceId: string): Promise<StoredUrl[]> {
    const directory = this.directory(workspaceId);
    try {
      const names = await readdir(directory);
      return await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) =>
        JSON.parse(await readFile(path.join(directory, name), "utf8")) as StoredUrl
      ));
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

class WorkspaceReverseProxy implements RouteProvider {
  readonly name: string;
  readonly upstreamMode: "container-dns" | "container-ip";
  readonly #routes = new Map<string, ResolvedWorkspaceTarget>();
  readonly #server: http.Server;
  readonly #ready: Promise<void>;

  constructor(
    options: Required<Pick<ReverseProxyOptions, "name" | "listenHost" | "listenPort" | "upstreamMode">>,
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
          provider: options.name,
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
    return { id: randomUUID(), provider: this.name, authority, providerId: authority };
  }

  async revoke(route: ExternalRoute): Promise<void> {
    this.#routes.delete(route.providerId ?? route.authority);
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

function domainProvider(
  name: string,
  domain: string,
  options: { machine?: string; scheme: "http" | "https"; port?: number }
): UrlProvider {
  const suffix = [options.machine, normalizeDomain(domain)].filter(Boolean).join(".");
  return {
    name,
    async publish(_workspace, request, route) {
      const authority = `${route.authority}.${suffix}${options.port === undefined ? "" : `:${options.port}`}`;
      return `${options.scheme}://${authority}${request.path ?? "/"}`;
    },
    async revoke() {}
  };
}

function validateRequest(value: unknown): NormalizedRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("request body must be an object");
  const input = value as Record<string, unknown>;
  if (typeof input.profile !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.profile)) {
    throw new UserError("profile must be a configured profile name");
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
    profile: input.profile,
    service: input.service,
    target: {
      containers: containers as string[],
      port: target.port as number,
      protocol: (target.protocol ?? "http") as "http" | "https"
    },
    ...(input.path === undefined ? {} : { path: input.path as string })
  };
}

function normalizeProfileConfiguration(
  options: ExternalUrlsPluginOptions,
  proxies: Array<Required<Pick<ReverseProxyOptions, "name" | "listenHost" | "listenPort" | "upstreamMode">>>
): {
  profiles: Readonly<Record<string, ExternalUrlProfile>>;
  bindings: Readonly<Record<string, ExternalUrlProfileBinding>>;
} {
  if (options.profiles || options.bindings) {
    return {
      profiles: { ...(options.profiles ?? {}) },
      bindings: { ...(options.bindings ?? {}) }
    };
  }
  const routeProvider = proxies[0]?.name ?? "reverse-proxy";
  return {
    profiles: {
      ...(options.tailscale ? {
        tailscale: {
          description: "Private URL reachable through the host Tailscale machine",
          protocol: options.tailscale.scheme ?? "https"
        }
      } : {}),
      ...(options.cloudflare ? {
        cloudflare: {
          description: "Public URL served through Cloudflare Tunnel",
          protocol: options.cloudflare.scheme ?? "https"
        }
      } : {})
    },
    bindings: {
      ...(options.tailscale ? {
      tailscale: {
        routeProvider,
        urlProvider: "tailscale"
      }
    } : {}),
      ...(options.cloudflare ? {
      cloudflare: {
        routeProvider,
        urlProvider: "cloudflare"
      }
    } : {})
    }
  };
}

function validateOptions(
  options: ExternalUrlsPluginOptions,
  proxies: Array<Required<Pick<ReverseProxyOptions, "name" | "listenHost" | "listenPort" | "upstreamMode">>>,
  profiles: Readonly<Record<string, ExternalUrlProfile>>,
  bindings: Readonly<Record<string, ExternalUrlProfileBinding>>
): void {
  for (const proxy of proxies) {
    if (!Number.isInteger(proxy.listenPort) || proxy.listenPort < 0 || proxy.listenPort > 65_535) {
      throw new Error("listenPort must be an integer between 0 and 65535");
    }
  }
  if (new Set(proxies.map((proxy) => proxy.name)).size !== proxies.length) throw new Error("proxy names must be unique");
  if (!options.tailscale && !options.cloudflare) throw new Error("at least one external URL provider must be configured");
  if (options.tailscale && !/^[a-z0-9-]+$/.test(options.tailscale.machine)) {
    throw new Error("tailscale machine must be a DNS label");
  }
  for (const provider of [options.tailscale, options.cloudflare]) {
    if (provider?.port !== undefined
      && (!Number.isInteger(provider.port) || provider.port < 1 || provider.port > 65_535)) {
      throw new Error("external URL provider port must be between 1 and 65535");
    }
  }
  for (const [name, profile] of Object.entries(profiles)) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error(`invalid external URL profile '${name}'`);
    if (typeof profile.description !== "string" || profile.description.trim().length === 0) {
      throw new Error(`external URL profile '${name}' requires a description`);
    }
    if (profile.protocol !== "http" && profile.protocol !== "https") {
      throw new Error(`external URL profile '${name}' protocol must be http or https`);
    }
    const binding = bindings[name];
    if (!binding) throw new Error(`external URL profile '${name}' requires a provider binding`);
    const proxy = proxies.find((candidate) => candidate.name === binding.routeProvider);
    if (!proxy) {
      throw new Error(`profile '${name}' references unknown route provider '${binding.routeProvider}'`);
    }
    if (binding.urlProvider === "tailscale" && !options.tailscale) throw new Error(`profile '${name}' requires tailscale`);
    if (binding.urlProvider === "tailscale" && proxy.upstreamMode !== "container-ip") {
      throw new Error(`tailscale profile '${name}' must use a host-reachable reverse proxy`);
    }
    if (binding.urlProvider === "cloudflare" && !options.cloudflare) throw new Error(`profile '${name}' requires cloudflare`);
    if (binding.urlProvider !== "tailscale" && binding.urlProvider !== "cloudflare") {
      throw new Error(`profile '${name}' references unknown URL provider '${binding.urlProvider}'`);
    }
    const providerScheme = binding.urlProvider === "tailscale"
      ? options.tailscale?.scheme ?? "https"
      : options.cloudflare?.scheme ?? "https";
    if (profile.protocol !== providerScheme) {
      throw new Error(`external URL profile '${name}' protocol does not match its configured URL scheme`);
    }
  }
  for (const name of Object.keys(bindings)) {
    if (!profiles[name]) throw new Error(`external URL binding '${name}' has no profile`);
  }
}

function normalizeProxies(
  options: ExternalUrlsPluginOptions
): Array<Required<Pick<ReverseProxyOptions, "name" | "listenHost" | "listenPort" | "upstreamMode">>> {
  const configured = options.proxies ?? [{
    listenHost: options.listenHost ?? "0.0.0.0",
    listenPort: options.listenPort ?? 8080,
    ...(options.upstreamMode ? { upstreamMode: options.upstreamMode } : {})
  }];
  return configured.map((proxy, index) => {
    const resolvedMode = proxy.upstreamMode ?? "container-ip";
    return {
      name: proxy.name ?? (configured.length === 1 ? "reverse-proxy" : `reverse-proxy-${index + 1}`),
      listenHost: proxy.listenHost,
      listenPort: proxy.listenPort,
      upstreamMode: resolvedMode
    };
  });
}

function parseProfiles(value: string): Readonly<Record<string, ExternalUrlProfile>> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DIM_EXTERNAL_URL_PROFILES must be a JSON object");
  }
  return parsed as Record<string, ExternalUrlProfile>;
}

function parseBindings(value: string): Readonly<Record<string, ExternalUrlProfileBinding>> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DIM_EXTERNAL_URL_BINDINGS must be a JSON object");
  }
  return parsed as Record<string, ExternalUrlProfileBinding>;
}

function parseProxyOptions(value: string): ReverseProxyOptions[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("DIM_EXTERNAL_URL_PROXIES must be a non-empty JSON array");
  }
  return parsed.map((item) => {
    if (!item || typeof item !== "object") throw new Error("each external URL proxy must be an object");
    const proxy = item as Record<string, unknown>;
    if (typeof proxy.listenHost !== "string" || typeof proxy.listenPort !== "number") {
      throw new Error("each external URL proxy requires listenHost and listenPort");
    }
    return {
      listenHost: proxy.listenHost,
      listenPort: proxy.listenPort,
      ...(typeof proxy.name === "string" ? { name: proxy.name } : {}),
      ...(typeof proxy.upstreamMode === "string" ? { upstreamMode: upstreamMode(proxy.upstreamMode) } : {})
    };
  });
}

function required<T>(values: ReadonlyMap<string, T>, name: string, kind: string): T {
  const value = values.get(name);
  if (!value) throw new UserError(`external ${kind} provider '${name}' is not configured`);
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
    profile: entry.profile,
    service: entry.service,
    target: entry.target,
    ...(entry.path === undefined ? {} : { path: entry.path })
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

function scheme(value: string): "http" | "https" {
  if (value !== "http" && value !== "https") throw new Error("external URL scheme must be http or https");
  return value;
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
  register(host) {
    return externalUrlsPluginFromEnv().register(host);
  }
};

export default plugin;
