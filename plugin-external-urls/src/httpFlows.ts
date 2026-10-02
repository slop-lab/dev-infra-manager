import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type net from "node:net";

export interface HttpFlow {
  readonly owner: symbol;
  readonly claim: string;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly upstreamRequest: ClientRequest;
  upstreamResponse?: IncomingMessage;
}

export interface UpgradedFlow {
  readonly owner: symbol;
  readonly claim: string;
  readonly client: import("node:stream").Duplex;
  readonly upstream: net.Socket;
}

export class HttpFlowTracker {
  readonly #http = new Set<HttpFlow>();
  readonly #upgraded = new Set<UpgradedFlow>();

  addHttp(flow: HttpFlow): void {
    this.#http.add(flow);
  }

  releaseHttp(flow: HttpFlow): void {
    this.#http.delete(flow);
  }

  destroyHttp(flow: HttpFlow): void {
    if (!this.#http.delete(flow)) return;
    flow.request.destroy();
    flow.response.destroy();
    flow.upstreamRequest.destroy();
    flow.upstreamResponse?.destroy();
  }

  addUpgrade(flow: UpgradedFlow): void {
    this.#upgraded.add(flow);
  }

  destroyUpgrade(flow: UpgradedFlow): void {
    if (!this.#upgraded.delete(flow)) return;
    flow.client.destroy();
    flow.upstream.destroy();
  }

  destroyClaim(claim: string): void {
    for (const flow of this.#http) {
      if (flow.claim === claim) this.destroyHttp(flow);
    }
    for (const flow of this.#upgraded) {
      if (flow.claim === claim) this.destroyUpgrade(flow);
    }
  }

  destroyOwner(owner: symbol): void {
    for (const flow of this.#http) {
      if (flow.owner === owner) this.destroyHttp(flow);
    }
    for (const flow of this.#upgraded) {
      if (flow.owner === owner) this.destroyUpgrade(flow);
    }
  }
}
