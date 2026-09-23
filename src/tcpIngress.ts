import net from "node:net";
import { UserError, type ControllerWorkspace, type ResolvedWorkspaceTarget, type WorkspaceTarget } from "@slop-lab/dim-core";

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

export interface TcpIngressOptions {
  readonly name: string;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly publicHost: string;
  readonly upstreamMode: "container-dns" | "container-ip";
}

export class TcpIngressListener {
  readonly name: string;
  readonly upstreamMode: "container-dns" | "container-ip";
  readonly #authority: string;
  readonly #server: net.Server;
  readonly #ready: Promise<void>;
  #route: { readonly claim: string; readonly upstream: ResolvedWorkspaceTarget } | undefined;

  constructor(options: TcpIngressOptions) {
    this.name = options.name;
    this.upstreamMode = options.upstreamMode;
    this.#authority = `${options.publicHost}:${options.listenPort}`;
    this.#server = net.createServer((client) => this.#forward(client));
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
    upstream: ResolvedWorkspaceTarget
  ): Promise<TcpExternalRoute> {
    await this.#ready;
    if (request.path !== undefined) throw new UserError("TCP ingress requests do not accept a URL path");
    if (request.target.protocol !== "tcp" || upstream.protocol !== "tcp") {
      throw new UserError("TCP ingresses require target.protocol 'tcp'");
    }
    const claim = `${workspace.id}\u0000${JSON.stringify(request.target)}`;
    if (this.#route !== undefined
      && (this.#route.claim !== claim || JSON.stringify(this.#route.upstream) !== JSON.stringify(upstream))) {
      throw new UserError(`TCP ingress '${this.name}' already targets another service`);
    }
    this.#route = { claim, upstream };
    return {
      id: claim,
      ingress: this.name,
      authority: this.#authority,
      ingressId: claim,
      url: `tcp://${this.#authority}`
    };
  }

  async revoke(route: TcpExternalRoute): Promise<void> {
    if (this.#route?.claim === route.ingressId) this.#route = undefined;
  }

  async close(): Promise<void> {
    await this.#ready.catch(() => undefined);
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error ? reject(error) : resolve());
    });
  }

  #forward(client: net.Socket): void {
    const route = this.#route;
    if (route === undefined) {
      client.destroy();
      return;
    }
    const upstream = net.connect(route.upstream.port, route.upstream.host);
    upstream.once("connect", () => client.pipe(upstream).pipe(client));
    upstream.once("error", () => client.destroy());
    client.once("error", () => upstream.destroy());
  }
}
