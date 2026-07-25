import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import {
  DIM_PLUGIN_API_VERSION,
  type DimPlugin,
  type ExternalRoute,
  type ExternalRouteProvider,
  type ExternalUrlProvider,
  type ExternalUrlUpstream
} from "@slop-lab/dev-infra-manager-core";

export interface ExternalUrlsPluginOptions {
  proxies?: ReverseProxyOptions[];
  listenHost?: string;
  listenPort?: number;
  placement?: ProxyPlacement;
  tailscale?: {
    machine: string;
    domain: string;
    scheme?: "http" | "https";
  };
  cloudflare?: {
    domain: string;
    scheme?: "http" | "https";
  };
}

export type ProxyPlacement = "host" | "controller";

export interface ReverseProxyOptions {
  name?: string;
  listenHost: string;
  listenPort: number;
  placement?: ProxyPlacement;
}

type ProxyTarget = ExternalUrlUpstream;

export function createExternalUrlsPlugin(options: ExternalUrlsPluginOptions): DimPlugin {
  const proxies = normalizeProxies(options);
  validateOptions(options, proxies);
  return {
    name: "@slop-lab/dim-plugin-external-urls",
    apiVersion: DIM_PLUGIN_API_VERSION,
    register(host) {
      const runningProxies = proxies.map((proxyOptions) => {
        const proxy = new WorkspaceReverseProxy(proxyOptions, host.logger);
        host.registerExternalRouteProvider(proxy);
        return proxy;
      });
      if (options.tailscale) {
        host.registerExternalUrlProvider(domainProvider("tailscale", options.tailscale.domain, {
          machine: options.tailscale.machine,
          scheme: options.tailscale.scheme ?? "https"
        }));
      }
      if (options.cloudflare) {
        host.registerExternalUrlProvider(domainProvider("cloudflare", options.cloudflare.domain, {
          scheme: options.cloudflare.scheme ?? "https"
        }));
      }
      return async () => {
        await Promise.all(runningProxies.map((proxy) => proxy.close()));
      };
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
          ...(env.DIM_EXTERNAL_URL_PROXY_PLACEMENT
            ? { placement: placement(env.DIM_EXTERNAL_URL_PROXY_PLACEMENT) }
            : {})
        }),
    ...(env.DIM_TAILSCALE_DOMAIN && env.DIM_TAILSCALE_MACHINE
      ? {
          tailscale: {
            domain: env.DIM_TAILSCALE_DOMAIN,
            machine: env.DIM_TAILSCALE_MACHINE,
            ...(env.DIM_TAILSCALE_SCHEME ? { scheme: scheme(env.DIM_TAILSCALE_SCHEME) } : {})
          }
        }
      : {}),
    ...(env.DIM_CLOUDFLARE_DOMAIN
      ? {
          cloudflare: {
            domain: env.DIM_CLOUDFLARE_DOMAIN,
            ...(env.DIM_CLOUDFLARE_SCHEME ? { scheme: scheme(env.DIM_CLOUDFLARE_SCHEME) } : {})
          }
        }
      : {})
  });
}

class WorkspaceReverseProxy implements ExternalRouteProvider {
  readonly name: string;
  readonly upstreamMode: "container-dns" | "container-ip";
  readonly #routes = new Map<string, ProxyTarget>();
  readonly #server: http.Server;
  readonly #ready: Promise<void>;

  constructor(
    options: Required<Pick<ReverseProxyOptions, "name" | "listenHost" | "listenPort" | "placement">>,
    logger: { info(message: string, fields?: Readonly<Record<string, unknown>>): void }
  ) {
    this.name = options.name;
    this.upstreamMode = options.placement === "host" ? "container-ip" : "container-dns";
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
          placement: options.placement
        });
        resolve();
      });
    });
  }

  async provision({ workspace, request, upstream }: Parameters<ExternalRouteProvider["provision"]>[0]) {
    await this.#ready;
    const authority = routeLabel(request.service, workspace.name);
    const existing = this.#routes.get(authority);
    const target = { ...upstream };
    if (existing && JSON.stringify(existing) !== JSON.stringify(target)) {
      throw new Error(`external route '${authority}' already targets another upstream`);
    }
    this.#routes.set(authority, target);
    return { authority, protocol: "http" as const, providerId: authority };
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

  #target(request: IncomingMessage): ProxyTarget | undefined {
    const hostname = (request.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
    const label = hostname.split(".")[0] ?? "";
    return this.#routes.get(label);
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
  options: { machine?: string; scheme: "http" | "https" }
): ExternalUrlProvider {
  const suffix = [options.machine, normalizeDomain(domain)].filter(Boolean).join(".");
  return {
    name,
    async publish({ request, route }) {
      const path = request.path ?? "/";
      return { url: `${options.scheme}://${route.authority}.${suffix}${path}` };
    },
    async revoke() {}
  };
}

function routeLabel(service: string, workspace: string): string {
  const value = `${service}--${workspace}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (value.length <= 63) return value;
  return `${value.slice(0, 54)}-${stableHash(value)}`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function scheme(value: string): "http" | "https" {
  if (value !== "http" && value !== "https") throw new Error("external URL scheme must be http or https");
  return value;
}

function normalizeDomain(value: string): string {
  return value.toLowerCase().replace(/^\.+|\.+$/g, "");
}

function validateOptions(
  options: ExternalUrlsPluginOptions,
  proxies: Array<Required<Pick<ReverseProxyOptions, "name" | "listenHost" | "listenPort" | "placement">>>
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
}

function normalizeProxies(
  options: ExternalUrlsPluginOptions
): Array<Required<Pick<ReverseProxyOptions, "name" | "listenHost" | "listenPort" | "placement">>> {
  const configured = options.proxies ?? [{
    listenHost: options.listenHost ?? "0.0.0.0",
    listenPort: options.listenPort ?? 8080,
    ...(options.placement ? { placement: options.placement } : {})
  }];
  return configured.map((proxy, index) => {
    const resolvedPlacement = proxy.placement ?? inferPlacement(proxy.listenHost);
    return {
      name: proxy.name ?? (configured.length === 1 ? "reverse-proxy" : `reverse-proxy-${resolvedPlacement}-${index + 1}`),
      listenHost: proxy.listenHost,
      listenPort: proxy.listenPort,
      placement: resolvedPlacement
    };
  });
}

function inferPlacement(listenHost: string): ProxyPlacement {
  return listenHost === "0.0.0.0" || listenHost === "::" ? "controller" : "host";
}

function placement(value: string): ProxyPlacement {
  if (value !== "host" && value !== "controller") throw new Error("proxy placement must be host or controller");
  return value;
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
      ...(typeof proxy.placement === "string" ? { placement: placement(proxy.placement) } : {})
    };
  });
}

const plugin: DimPlugin = {
  name: "@slop-lab/dim-plugin-external-urls",
  apiVersion: DIM_PLUGIN_API_VERSION,
  register(host) {
    return externalUrlsPluginFromEnv().register(host);
  }
};

export default plugin;
