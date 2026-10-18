import net from "node:net";
import { UserError, type ControllerWorkspace, type ResolvedWorkspaceTarget, type WorkspaceTarget } from "@slop-lab/dim-managed";
import type { ExternalUrlApproval } from "./routeStore.js";

export interface TcpIngressRequest {
  readonly target: WorkspaceTarget;
  readonly path?: string;
}

export interface TcpExternalRoute {
  readonly id: string;
  readonly ingress: string;
  readonly authority: string;
  readonly ingressId: string;
  readonly url: string;
}

export interface TcpIngressProvision {
  readonly route: TcpExternalRoute;
  readonly acquired: boolean;
}

export interface TcpIngressOptions {
  readonly name: string;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly publicHost: string;
  readonly maxConnections?: number;
  readonly connectTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly authorizeWorkspace?: (workspace: ControllerWorkspace) => Promise<void>;
}

const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

type TcpConnection = {
  readonly client: net.Socket;
  readonly upstream: net.Socket;
};

export class TcpIngressListener {
  readonly name: string;
  readonly #authority: string;
  readonly #server: net.Server;
  readonly #ready: Promise<void>;
  readonly #connections = new Set<TcpConnection>();
  readonly #maxConnections: number;
  readonly #connectTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #authorizeWorkspace: ((workspace: ControllerWorkspace) => Promise<void>) | undefined;
  #route: {
    readonly claim: string;
    readonly workspace: ControllerWorkspace;
    readonly upstream: ResolvedWorkspaceTarget | undefined;
    readonly enabled: boolean;
    readonly resolve: (() => Promise<ResolvedWorkspaceTarget>) | undefined;
  } | undefined;

  constructor(options: TcpIngressOptions) {
    this.name = options.name;
    this.#authorizeWorkspace = options.authorizeWorkspace;
    this.#maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#authority = `${options.publicHost}:${options.listenPort}`;
    this.#server = net.createServer({ allowHalfOpen: true }, (client) => this.#forward(client));
    this.#ready = new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(options.listenPort, options.listenHost, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  async provision(
    workspace: ControllerWorkspace,
    request: TcpIngressRequest,
    upstream: ResolvedWorkspaceTarget | undefined,
    routeId = `${workspace.id}\u0000${JSON.stringify(request.target)}`,
    approval: ExternalUrlApproval = "not-required",
    _publicRouteId?: string,
    resolve?: () => Promise<ResolvedWorkspaceTarget>
  ): Promise<TcpIngressProvision> {
    await this.#ready;
    if (!upstream && !resolve) throw new UserError("external route requires an authoritative target resolver");
    if (request.path !== undefined) throw new UserError("TCP ingress requests do not accept a URL path");
    if (request.target.protocol !== "tcp" || upstream !== undefined && upstream.protocol !== "tcp") {
      throw new UserError("TCP ingresses require target.protocol 'tcp'");
    }
    const claim = routeId;
    if (this.#route !== undefined && this.#route.claim !== claim) {
      throw new UserError(`TCP ingress '${this.name}' already targets another service`);
    }
    const acquired = this.#route === undefined;
    if (!acquired && JSON.stringify(this.#route?.upstream) !== JSON.stringify(upstream)) {
      this.#destroyConnections();
    }
    this.#route = { claim, workspace, upstream, resolve, enabled: approval === "not-required" || approval === "approved" };
    return {
      acquired,
      route: {
        id: claim,
        ingress: this.name,
        authority: this.#authority,
        ingressId: claim,
        url: `tcp://${this.#authority}`
      }
    };
  }

  async revoke(route: TcpExternalRoute): Promise<void> {
    if (this.#route?.claim !== route.ingressId) return;
    this.#route = undefined;
    this.#destroyConnections();
  }

  setApproval(route: TcpExternalRoute, enabled: boolean): void {
    if (this.#route?.claim !== route.ingressId) throw new UserError("external URL route is not active");
    this.#route = { ...this.#route, enabled };
    if (!enabled) this.#destroyConnections();
  }

  async close(): Promise<void> {
    await this.#ready.catch(() => undefined);
    if (!this.#server.listening) return;
    const closed = new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error ? reject(error) : resolve());
    });
    this.#route = undefined;
    this.#destroyConnections();
    await closed;
  }

  async #forward(client: net.Socket): Promise<void> {
    client.once("error", () => {});
    const route = this.#route;
    if (!route?.enabled || this.#connections.size >= this.#maxConnections) { client.destroy(); return; }
    let target: ResolvedWorkspaceTarget | undefined;
    try {
      if (route) await this.#authorizeWorkspace?.(route.workspace);
      target = route?.resolve ? await route.resolve() : route?.upstream;
    } catch { client.destroy(); return; }
    if (route === undefined || target === undefined || !route.enabled || this.#route !== route || client.destroyed) {
      client.destroy();
      return;
    }
    if (this.#connections.size >= this.#maxConnections) {
      client.destroy();
      return;
    }
    const upstream = net.connect({ port: target.port, host: target.host, allowHalfOpen: true });
    const connection = { client, upstream };
    this.#connections.add(connection);
    const destroy = () => {
      this.#connections.delete(connection);
      client.destroy();
      upstream.destroy();
    };
    client.setTimeout(this.#idleTimeoutMs, destroy);
    upstream.setTimeout(this.#connectTimeoutMs, destroy);
    upstream.once("connect", () => {
      upstream.setTimeout(this.#idleTimeoutMs);
      client.pipe(upstream).pipe(client);
    });
    // A clean read EOF ends only the opposite write direction through pipe().
    // In particular, client FIN must leave room for a delayed upstream reply.
    upstream.once("close", () => { if (!upstream.readableEnded) destroy(); });
    upstream.once("error", destroy);
    client.once("close", destroy);
    client.once("error", destroy);
  }

  #destroyConnections(): void {
    for (const connection of this.#connections) {
      connection.client.destroy();
      connection.upstream.destroy();
    }
    this.#connections.clear();
  }
}
