import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import {
  UserError,
  type ControllerWorkspace,
  type DimPluginLogger,
  type ResolvedWorkspaceTarget,
  type WorkspaceTarget
} from "@slop-lab/dim-core";
import { HttpFlowTracker, type HttpFlow } from "./httpFlows.js";
import { WorkspaceRouteRegistry } from "./httpRouteRegistry.js";
import { applyRoutePolicy, type ExternalUrlRoutePolicyConfig } from "./routePolicy.js";
import type { ExternalRoute, ExternalUrlApproval } from "./routeStore.js";

export interface HttpIngressRequest {
  readonly ingress: string;
  readonly subdomain?: string;
  readonly target: WorkspaceTarget;
  readonly path?: string;
}

export interface HttpIngressOptions {
  readonly name: string;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly upstreamMode: "container-dns" | "container-ip";
  readonly scheme: "http" | "https";
  readonly domain: string;
  readonly port?: number;
  readonly routePolicy?: ExternalUrlRoutePolicyConfig;
}

export class WorkspaceIngressListener {
  readonly name: string;
  readonly upstreamMode: "container-dns" | "container-ip";
  readonly #registry: WorkspaceRouteRegistry;
  readonly #server: http.Server;
  readonly #ready: Promise<void>;
  readonly #scheme: "http" | "https";
  readonly #domain: string;
  readonly #port: number | undefined;
  readonly #routePolicy: ExternalUrlRoutePolicyConfig | undefined;
  readonly #flows: HttpFlowTracker;
  readonly #flowOwner = Symbol("external-url-listener");

  constructor(registry: WorkspaceRouteRegistry, options: HttpIngressOptions, logger: DimPluginLogger) {
    this.#registry = registry;
    this.#flows = registry.flows;
    this.name = options.name;
    this.upstreamMode = options.upstreamMode;
    this.#scheme = options.scheme;
    this.#domain = options.domain;
    this.#port = options.port;
    this.#routePolicy = options.routePolicy;
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

  async provision(
    workspace: ControllerWorkspace,
    request: HttpIngressRequest,
    upstream: ResolvedWorkspaceTarget,
    routeId = randomUUID(),
    approval: ExternalUrlApproval = "not-required"
  ) {
    await this.#ready;
    if (request.subdomain === undefined) throw new UserError("HTTP ingress requests require a subdomain");
    const subdomain = await applyRoutePolicy(this.#routePolicy, {
      workspace: { id: workspace.id, name: workspace.name },
      ingress: this.name,
      requestedSubdomain: request.subdomain,
      domain: normalizeDomain(this.#domain)
    });
    validateSubdomain(subdomain);
    const authority = `${subdomain}.${normalizeDomain(this.#domain)}`;
    const claim = routeId;
    const acquired = this.#registry.provision({
      authority,
      claim,
      upstream,
      enabled: approval === "not-required" || approval === "approved",
      beforeRebind: () => this.#flows.destroyClaim(claim)
    });
    const publicAuthority = `${authority}${this.#port === undefined ? "" : `:${this.#port}`}`;
    const url = validateExternalUrl(`${this.#scheme}://${publicAuthority}${request.path ?? "/"}`);
    return { acquired, route: { id: randomUUID(), ingress: this.name, authority, ingressId: claim, url } };
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  async revoke(route: ExternalRoute): Promise<void> {
    const claim = route.ingressId ?? route.authority;
    this.#registry.revoke(route.authority, claim);
    this.#flows.destroyClaim(claim);
  }

  setApproval(route: ExternalRoute, enabled: boolean): void {
    const claim = route.ingressId ?? route.authority;
    this.#registry.setApproval(route.authority, claim, enabled);
    if (!enabled) this.#flows.destroyClaim(claim);
  }

  async close(): Promise<void> {
    await this.#ready.catch(() => {});
    if (!this.#server.listening) return;
    const closed = new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error ? reject(error) : resolve());
    });
    this.#server.closeAllConnections();
    this.#flows.destroyOwner(this.#flowOwner);
    await closed;
  }

  #target(request: IncomingMessage): { readonly upstream: ResolvedWorkspaceTarget; readonly claim: string } | undefined {
    const hostname = (request.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
    return this.#registry.target(hostname);
  }

  #proxy(request: IncomingMessage, response: ServerResponse): void {
    const selected = this.#target(request);
    if (!selected) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"external route not found"}\n');
      return;
    }
    const target = selected.upstream;
    const transport = target.protocol === "https" ? https : http;
    const upstreamRequest = transport.request({
      hostname: target.host,
      port: target.port,
      method: request.method,
      path: request.url ?? "/",
      headers: {
        ...proxyHeaders(request.headers),
        host: `${target.host}:${target.port}`,
        "x-forwarded-host": request.headers.host ?? "",
        "x-forwarded-proto": this.#scheme,
        "x-forwarded-for": request.socket.remoteAddress ?? ""
      }
    });
    const flow: HttpFlow = {
      owner: this.#flowOwner,
      claim: selected.claim,
      request,
      response,
      upstreamRequest
    };
    this.#flows.addHttp(flow);
    upstreamRequest.once("response", (upstreamResponse) => {
      flow.upstreamResponse = upstreamResponse;
      upstreamResponse.once("aborted", () => this.#flows.destroyHttp(flow));
      upstreamResponse.once("error", () => this.#flows.destroyHttp(flow));
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstreamRequest.once("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.once("aborted", () => this.#flows.destroyHttp(flow));
    request.once("error", () => this.#flows.destroyHttp(flow));
    response.once("close", () => {
      if (response.writableFinished) this.#flows.releaseHttp(flow);
      else this.#flows.destroyHttp(flow);
    });
    request.pipe(upstreamRequest);
  }

  #upgrade(request: IncomingMessage, client: import("node:stream").Duplex, head: Buffer): void {
    const selected = this.#target(request);
    if (!selected) {
      client.destroy();
      return;
    }
    const target = selected.upstream;
    const upstream = target.protocol === "https"
      ? tls.connect(target.port, target.host)
      : net.connect(target.port, target.host);
    const upgrade = { owner: this.#flowOwner, claim: selected.claim, client, upstream };
    this.#flows.addUpgrade(upgrade);
    const destroy = () => this.#flows.destroyUpgrade(upgrade);
    upstream.once("connect", () => {
      const headers = Object.entries(request.headers)
        .flatMap(([name, value]) => Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value ?? ""}`]);
      upstream.write(`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.once("close", destroy);
    upstream.once("error", destroy);
    client.once("close", destroy);
    client.once("error", destroy);
  }
}

function validateExternalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UserError("provider returned a non-HTTP URL");
  if (url.username || url.password) throw new UserError("provider returned a URL containing credentials");
  return url.href;
}

function validateSubdomain(value: string): void {
  if (value.length === 0 || value.length > 253 || value.endsWith(".")
    || !value.split(".").every((label) =>
      label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new UserError("subdomain must be a lowercase relative DNS name");
  }
}

function proxyHeaders(headers: IncomingMessage["headers"]): IncomingMessage["headers"] {
  const result = { ...headers };
  for (const name of ["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]) {
    delete result[name];
  }
  return result;
}

function normalizeDomain(value: string): string {
  return value.toLowerCase().replace(/^\.+|\.+$/g, "");
}
