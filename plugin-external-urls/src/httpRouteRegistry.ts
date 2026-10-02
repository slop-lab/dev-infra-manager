import { UserError, type ResolvedWorkspaceTarget } from "@slop-lab/dim-core";
import { HttpFlowTracker } from "./httpFlows.js";

interface RegisteredRoute {
  upstream: ResolvedWorkspaceTarget;
  readonly claims: Map<string, boolean>;
}

interface RouteProvision {
  readonly authority: string;
  readonly claim: string;
  readonly upstream: ResolvedWorkspaceTarget;
  readonly enabled: boolean;
  readonly beforeRebind: () => void;
}

export class WorkspaceRouteRegistry {
  readonly #routes = new Map<string, RegisteredRoute>();
  readonly flows = new HttpFlowTracker();

  provision(input: RouteProvision): boolean {
    const existing = this.#routes.get(input.authority);
    if (existing && JSON.stringify(existing.upstream) !== JSON.stringify(input.upstream)) {
      if (existing.claims.size !== 1 || !existing.claims.has(input.claim)) {
        throw new UserError(`external route '${input.authority}' already targets another service`);
      }
      input.beforeRebind();
      existing.upstream = input.upstream;
      return false;
    }
    if (existing) {
      const acquired = !existing.claims.has(input.claim);
      existing.claims.set(input.claim, input.enabled);
      return acquired;
    }
    this.#routes.set(input.authority, {
      upstream: input.upstream,
      claims: new Map([[input.claim, input.enabled]])
    });
    return true;
  }

  revoke(authority: string, claim: string): void {
    const existing = this.#routes.get(authority);
    if (!existing) return;
    existing.claims.delete(claim);
    if (existing.claims.size === 0) this.#routes.delete(authority);
  }

  setApproval(authority: string, claim: string, enabled: boolean): void {
    const existing = this.#routes.get(authority);
    if (existing === undefined || !existing.claims.has(claim)) throw new UserError("external URL route is not active");
    existing.claims.set(claim, enabled);
  }

  target(host: string): { readonly upstream: ResolvedWorkspaceTarget; readonly claim: string } | undefined {
    const route = this.#routes.get(host.toLowerCase().replace(/\.$/, ""));
    if (route === undefined) return undefined;
    const claim = [...route.claims].find(([, enabled]) => enabled)?.[0];
    return claim === undefined ? undefined : { upstream: route.upstream, claim };
  }
}
