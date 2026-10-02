import { UserError, type ResolvedWorkspaceTarget } from "@slop-lab/dim-core";
import { HttpFlowTracker } from "./httpFlows.js";

interface RegisteredRoute {
  upstream: ResolvedWorkspaceTarget;
  readonly claims: Map<string, boolean>;
}

interface RouteProvision {
  readonly authorities: readonly string[];
  readonly claim: string;
  readonly upstream: ResolvedWorkspaceTarget;
  readonly enabled: boolean;
  readonly beforeRebind: () => void;
}

export class WorkspaceRouteRegistry {
  readonly #routes = new Map<string, RegisteredRoute>();
  readonly flows = new HttpFlowTracker();

  provision(input: RouteProvision): boolean {
    const authorities = [...new Set(input.authorities)];
    if (authorities.length === 0) throw new UserError("external route requires at least one authority");
    for (const authority of authorities) {
      const existing = this.#routes.get(authority);
      if (existing === undefined) continue;
      if (existing.claims.size !== 1 || !existing.claims.has(input.claim)) {
        throw new UserError(`external route '${authority}' already belongs to another route`);
      }
    }
    const requiresRebind = authorities.some((authority) => {
      const existing = this.#routes.get(authority);
      return existing !== undefined && JSON.stringify(existing.upstream) !== JSON.stringify(input.upstream);
    });
    if (requiresRebind) input.beforeRebind();
    let acquired = false;
    for (const authority of authorities) {
      const existing = this.#routes.get(authority);
      if (existing === undefined) {
        this.#routes.set(authority, {
          upstream: input.upstream,
          claims: new Map([[input.claim, input.enabled]])
        });
        acquired = true;
        continue;
      }
      acquired = !existing.claims.has(input.claim) || acquired;
      existing.upstream = input.upstream;
      existing.claims.set(input.claim, input.enabled);
    }
    return acquired;
  }

  revoke(authorities: readonly string[], claim: string): void {
    for (const authority of authorities) {
      const existing = this.#routes.get(authority);
      if (!existing) continue;
      existing.claims.delete(claim);
      if (existing.claims.size === 0) this.#routes.delete(authority);
    }
  }

  setApproval(authorities: readonly string[], claim: string, enabled: boolean): void {
    const routes = authorities.map((authority) => this.#routes.get(authority));
    if (routes.some((route) => route === undefined || !route.claims.has(claim))) {
      throw new UserError("external URL route is not active");
    }
    for (const route of routes) {
      if (route !== undefined) route.claims.set(claim, enabled);
    }
  }

  target(host: string): { readonly upstream: ResolvedWorkspaceTarget; readonly claim: string } | undefined {
    const route = this.#routes.get(host.toLowerCase().replace(/\.$/, ""));
    if (route === undefined) return undefined;
    const claim = [...route.claims].find(([, enabled]) => enabled)?.[0];
    return claim === undefined ? undefined : { upstream: route.upstream, claim };
  }
}
