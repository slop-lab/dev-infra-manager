import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NativeBasicCredential } from "./native-basic-auth.js";

const leaseLifetimeMilliseconds = 30_000;
const maximumLiveLeases = 16;

export type WorkspaceWriteLeaseScope = {
  readonly generationId: string;
  readonly ownerHostId: string;
  readonly projectId: string;
  readonly repositoryId: "root";
  readonly workspaceId: string;
};
export type IssuedWorkspaceWriteLease = NativeBasicCredential & WorkspaceWriteLeaseScope & {
  readonly expiresAt: number;
};
type StoredWorkspaceWriteLease = WorkspaceWriteLeaseScope & {
  readonly expiresAt: number;
  readonly passwordDigest: Buffer;
};

export type WorkspaceWriteLeaseRegistry = {
  authenticate(credential: NativeBasicCredential): WorkspaceWriteLeaseScope | undefined;
  clear(): void;
  issue(scope: WorkspaceWriteLeaseScope): IssuedWorkspaceWriteLease | undefined;
};

export function createWorkspaceWriteLeaseRegistry(now: () => number): WorkspaceWriteLeaseRegistry {
  const leases = new Map<string, StoredWorkspaceWriteLease>();
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
        projectId: lease.projectId,
        repositoryId: lease.repositoryId,
        workspaceId: lease.workspaceId
      };
    },
    clear() {
      leases.clear();
    },
    issue(scope) {
      pruneExpired();
      if (leases.size >= maximumLiveLeases) return undefined;
      const username = `workspace-write-${randomBytes(18).toString("base64url")}`;
      const password = randomBytes(32).toString("base64url");
      const expiresAt = now() + leaseLifetimeMilliseconds;
      leases.set(digest(username), { ...scope, expiresAt, passwordDigest: digestBuffer(password) });
      return { ...scope, username, password, expiresAt };
    }
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestBuffer(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
