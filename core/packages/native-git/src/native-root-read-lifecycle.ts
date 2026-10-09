import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const leaseLifetimeMilliseconds = 30_000;
const maximumLiveLeases = 16;

export type RootReadCredential = { readonly username: string; readonly password: string };
export type RootReadLeaseScope = {
  readonly generationId: string;
  readonly ownerHostId: string;
  readonly projectId: string;
};
export type IssuedRootReadLease = RootReadCredential & RootReadLeaseScope & { readonly expiresAt: number };

type StoredRootReadLease = RootReadLeaseScope & {
  readonly expiresAt: number;
  readonly passwordDigest: Buffer;
};

export type RootReadLeaseRegistry = {
  authenticate(credential: RootReadCredential): RootReadLeaseScope | undefined;
  clear(): void;
  issue(scope: RootReadLeaseScope): IssuedRootReadLease | undefined;
};

export function createRootReadLeaseRegistry(now: () => number): RootReadLeaseRegistry {
  const leases = new Map<string, StoredRootReadLease>();
  const pruneExpired = (): void => {
    const currentTime = now();
    for (const [key, lease] of leases) {
      if (currentTime >= lease.expiresAt) leases.delete(key);
    }
  };
  return {
    authenticate(credential) {
      pruneExpired();
      const lease = leases.get(digest(credential.username));
      if (lease === undefined || !timingSafeEqual(lease.passwordDigest, digestBuffer(credential.password))) {
        return undefined;
      }
      return {
        generationId: lease.generationId,
        ownerHostId: lease.ownerHostId,
        projectId: lease.projectId
      };
    },
    clear() {
      leases.clear();
    },
    issue(scope) {
      pruneExpired();
      if (leases.size >= maximumLiveLeases) return undefined;
      const username = `root-read-${randomBytes(18).toString("base64url")}`;
      const password = randomBytes(32).toString("base64url");
      const expiresAt = now() + leaseLifetimeMilliseconds;
      leases.set(digest(username), { ...scope, expiresAt, passwordDigest: digestBuffer(password) });
      return { ...scope, username, password, expiresAt };
    }
  };
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

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestBuffer(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
