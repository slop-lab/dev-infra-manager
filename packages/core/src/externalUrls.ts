import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { UserError } from "./errors.js";

export type ExternalUrlProtocol = "http" | "https";

export interface ExternalUrlRequest {
  service: string;
  port: number;
  protocol?: ExternalUrlProtocol;
  path?: string;
  routeProvider?: string;
  urlProviders?: string[];
}

export interface ExternalUrlWorkspace {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
}

export interface ExternalUrlUpstream {
  protocol: ExternalUrlProtocol;
  host: string;
  port: number;
}

export interface ExternalRoute {
  id: string;
  provider: string;
  authority: string;
  protocol: ExternalUrlProtocol;
  providerId?: string;
}

export interface ExternalUrlEntry {
  id: string;
  workspace: string;
  service: string;
  routeProvider: string;
  urlProvider: string;
  url: string;
  createdAt: string;
}

export interface ExternalUrlProviderContext {
  workspace: ExternalUrlWorkspace;
  request: NormalizedExternalUrlRequest;
  route: ExternalRoute;
}

export interface ExternalRouteProviderContext {
  workspace: ExternalUrlWorkspace;
  request: NormalizedExternalUrlRequest;
  upstream: ExternalUrlUpstream;
}

export interface ExternalRouteProvider {
  readonly name: string;
  readonly upstreamMode?: "container-dns" | "container-ip";
  provision(context: ExternalRouteProviderContext): Promise<Omit<ExternalRoute, "id" | "provider">>;
  revoke(route: ExternalRoute): Promise<void>;
}

export interface ExternalUrlProvider {
  readonly name: string;
  publish(context: ExternalUrlProviderContext): Promise<{ url: string; providerId?: string }>;
  revoke(entry: ExternalUrlStoreEntry): Promise<void>;
}

export interface ExternalUrlStoreEntry extends ExternalUrlEntry {
  route: ExternalRoute;
  request: NormalizedExternalUrlRequest;
  providerId?: string;
}

export interface ExternalUrlStore {
  list(workspaceId: string): Promise<ExternalUrlStoreEntry[]>;
  put(workspaceId: string, entry: ExternalUrlStoreEntry): Promise<void>;
  remove(workspaceId: string, id: string): Promise<ExternalUrlStoreEntry | undefined>;
}

export interface ExternalUrlControllerOptions {
  authenticate(token: string): Promise<ExternalUrlWorkspace | undefined>;
  resolveUpstream(
    workspace: ExternalUrlWorkspace,
    request: ExternalUrlRequest,
    routeProvider: ExternalRouteProvider
  ): Promise<ExternalUrlUpstream>;
  routeProviders: ReadonlyMap<string, ExternalRouteProvider>;
  urlProviders: ReadonlyMap<string, ExternalUrlProvider>;
  store: ExternalUrlStore;
  maxBodyBytes?: number;
}

export type NormalizedExternalUrlRequest =
  Required<Pick<ExternalUrlRequest, "service" | "port" | "protocol">>
  & Pick<ExternalUrlRequest, "path">;

export class MemoryExternalUrlStore implements ExternalUrlStore {
  readonly #entries = new Map<string, Map<string, ExternalUrlStoreEntry>>();

  async list(workspaceId: string): Promise<ExternalUrlStoreEntry[]> {
    return [...(this.#entries.get(workspaceId)?.values() ?? [])];
  }

  async put(workspaceId: string, entry: ExternalUrlStoreEntry): Promise<void> {
    let entries = this.#entries.get(workspaceId);
    if (!entries) {
      entries = new Map();
      this.#entries.set(workspaceId, entries);
    }
    entries.set(entry.id, entry);
  }

  async remove(workspaceId: string, id: string): Promise<ExternalUrlStoreEntry | undefined> {
    const entries = this.#entries.get(workspaceId);
    const entry = entries?.get(id);
    if (entry) entries?.delete(id);
    return entry;
  }
}

export function createExternalUrlController(options: ExternalUrlControllerOptions): Server {
  return createServer((request, response) => {
    void handleRequest(options, request, response).catch((error) => {
      sendError(response, error instanceof UserError ? 400 : 500, error instanceof Error ? error.message : String(error));
    });
  });
}

async function handleRequest(
  options: ExternalUrlControllerOptions,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const workspace = await authenticate(options, request);
  if (!workspace) return sendError(response, 401, "invalid workspace grant");
  const url = new URL(request.url ?? "/", "http://dim-controller");

  if (request.method === "GET" && url.pathname === "/api/external-urls/list") {
    return sendJson(response, 200, { urls: publicEntries(await options.store.list(workspace.id)) });
  }
  if (request.method === "POST" && url.pathname === "/api/external-urls/request") {
    const input = validateRequest(await readJson(request, options.maxBodyBytes ?? 16_384));
    const normalized: NormalizedExternalUrlRequest = {
      service: input.service,
      port: input.port,
      protocol: input.protocol ?? "http",
      ...(input.path === undefined ? {} : { path: input.path })
    };
    const routeProvider = selectProvider(options.routeProviders, input.routeProvider, "route");
    const upstream = await options.resolveUpstream(workspace, input, routeProvider);
    const urlProviders = input.urlProviders?.map((name) => selectNamedProvider(options.urlProviders, name, "URL"))
      ?? [...options.urlProviders.values()];
    if (urlProviders.length === 0) throw new UserError("no external URL providers are configured");

    const provisionedRoute = await routeProvider.provision({ workspace, request: normalized, upstream });
    const route: ExternalRoute = {
      id: randomUUID(),
      provider: routeProvider.name,
      ...provisionedRoute
    };
    const created: ExternalUrlStoreEntry[] = [];
    try {
      for (const provider of urlProviders) {
        const published = await provider.publish({ workspace, request: normalized, route });
        const entry: ExternalUrlStoreEntry = {
          id: randomUUID(),
          workspace: workspace.name,
          service: input.service,
          routeProvider: route.provider,
          urlProvider: provider.name,
          url: validateExternalUrl(published.url),
          createdAt: new Date().toISOString(),
          route,
          request: normalized,
          ...(published.providerId === undefined ? {} : { providerId: published.providerId })
        };
        await options.store.put(workspace.id, entry);
        created.push(entry);
      }
    } catch (error) {
      await Promise.allSettled(created.map(async (entry) => {
        await options.urlProviders.get(entry.urlProvider)?.revoke(entry);
        await options.store.remove(workspace.id, entry.id);
      }));
      await routeProvider.revoke(route);
      throw error;
    }
    return sendJson(response, 201, { urls: publicEntries(created) });
  }
  const revoke = request.method === "DELETE"
    ? /^\/api\/external-urls\/([^/]+)$/.exec(url.pathname)
    : undefined;
  if (revoke) {
    const id = decodeURIComponent(revoke[1] ?? "");
    const entries = await options.store.list(workspace.id);
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) return sendError(response, 404, "external URL not found");
    const provider = selectNamedProvider(options.urlProviders, entry.urlProvider, "URL");
    await provider.revoke(entry);
    await options.store.remove(workspace.id, id);
    if (!entries.some((candidate) => candidate.id !== id && candidate.route.id === entry.route.id)) {
      await selectNamedProvider(options.routeProviders, entry.route.provider, "route").revoke(entry.route);
    }
    response.writeHead(204).end();
    return;
  }
  sendError(response, 404, "not found");
}

function selectProvider<T extends { name: string }>(
  providers: ReadonlyMap<string, T>,
  requested: string | undefined,
  kind: string
): T {
  if (requested) return selectNamedProvider(providers, requested, kind);
  if (providers.size !== 1) {
    throw new UserError(`routeProvider is required when ${providers.size} ${kind} providers are configured`);
  }
  return [...providers.values()][0] as T;
}

function selectNamedProvider<T>(providers: ReadonlyMap<string, T>, name: string, kind: string): T {
  const provider = providers.get(name);
  if (!provider) throw new UserError(`external ${kind} provider '${name}' is not configured`);
  return provider;
}

function validateRequest(value: unknown): ExternalUrlRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("request body must be an object");
  const input = value as Record<string, unknown>;
  if (typeof input.service !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.service)) {
    throw new UserError("service must be a DNS label");
  }
  if (!Number.isInteger(input.port) || (input.port as number) < 1 || (input.port as number) > 65_535) {
    throw new UserError("port must be an integer between 1 and 65535");
  }
  if (input.protocol !== undefined && input.protocol !== "http" && input.protocol !== "https") {
    throw new UserError("protocol must be http or https");
  }
  if (input.path !== undefined && (typeof input.path !== "string" || !input.path.startsWith("/") || input.path.includes(".."))) {
    throw new UserError("path must be an absolute URL path without '..'");
  }
  if (input.routeProvider !== undefined && (typeof input.routeProvider !== "string" || input.routeProvider.length === 0)) {
    throw new UserError("routeProvider must be a non-empty string");
  }
  if (input.urlProviders !== undefined && (!Array.isArray(input.urlProviders) || input.urlProviders.length === 0
    || !input.urlProviders.every((item) => typeof item === "string" && item.length > 0))) {
    throw new UserError("urlProviders must be a non-empty string array");
  }
  return {
    service: input.service,
    port: input.port as number,
    ...(input.protocol === undefined ? {} : { protocol: input.protocol as ExternalUrlProtocol }),
    ...(input.path === undefined ? {} : { path: input.path as string }),
    ...(input.routeProvider === undefined ? {} : { routeProvider: input.routeProvider as string }),
    ...(input.urlProviders === undefined ? {} : { urlProviders: [...new Set(input.urlProviders as string[])] })
  };
}

async function authenticate(options: ExternalUrlControllerOptions, request: IncomingMessage): Promise<ExternalUrlWorkspace | undefined> {
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

function validateExternalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UserError("provider returned a non-HTTP URL");
  if (url.username || url.password) throw new UserError("provider returned a URL containing credentials");
  return url.href;
}

function publicEntries(entries: ExternalUrlStoreEntry[]): ExternalUrlEntry[] {
  return entries.map(({ providerId: _providerId, route: _route, request: _request, ...entry }) => entry);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  sendJson(response, status, { error: message });
}
