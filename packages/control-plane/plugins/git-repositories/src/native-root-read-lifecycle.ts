import { createNativeSignedLease } from "./native-signed-lease.js";

const leaseLifetimeMilliseconds = 30_000;

export type RootReadCredential = { readonly username: string; readonly password: string };
export type RootReadLeaseScope = {
  readonly generationId: string;
  readonly ownerHostId: string;
  readonly projectId: string;
  readonly repositoryId: string;
};
export type IssuedRootReadLease = RootReadCredential & RootReadLeaseScope & { readonly issuedAt: number; readonly expiresAt: number };

export type RootReadLeaseRegistry = {
  authenticate(credential: RootReadCredential): RootReadLeaseScope | undefined;
  clear(): void;
  issue(scope: RootReadLeaseScope): IssuedRootReadLease;
};

export function createRootReadLeaseRegistry(now: () => number): RootReadLeaseRegistry {
  const leases = createNativeSignedLease("root-read-", leaseLifetimeMilliseconds, now);
  return {
    authenticate(credential) {
      const scope = leases.authenticate(credential);
      if (!fourStrings(scope)) return;
      const [generationId, ownerHostId, projectId, repositoryId] = scope;
      return { generationId, ownerHostId, projectId, repositoryId };
    },
    clear: leases.clear,
    issue(scope) {
      return { ...scope, ...leases.issue([scope.generationId, scope.ownerHostId, scope.projectId, scope.repositoryId]) };
    }
  };
}

function fourStrings(value: readonly unknown[] | undefined): value is readonly [string, string, string, string] {
  return value?.length === 4 && value.every((entry) => typeof entry === "string");
}

export type RootReadOperationGate = {
  acquire(): (() => void) | undefined;
  close(): Promise<void>;
  isOpen(): boolean;
};

export function createRootReadOperationGate(maximumActive: number): RootReadOperationGate {
  let open = true;
  let active = 0;
  let idle = Promise.resolve();
  let resolveIdle: (() => void) | undefined;
  return {
    acquire() {
      if (!open || active >= maximumActive) return undefined;
      if (active === 0) idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
      active += 1;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        active -= 1;
        if (active === 0) {
          resolveIdle?.();
          resolveIdle = undefined;
        }
      };
    },
    close() {
      open = false;
      return idle;
    },
    isOpen() {
      return open;
    }
  };
}
