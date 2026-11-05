import type { NativeBasicCredential } from "./native-basic-auth.js";
import { createNativeSignedLease } from "./native-signed-lease.js";

const leaseLifetimeMilliseconds = 30_000;

export type WorkspaceWriteLeaseScope = {
  readonly generationId: string;
  readonly ownerHostId: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
};
export type IssuedWorkspaceWriteLease = NativeBasicCredential & WorkspaceWriteLeaseScope & {
  readonly issuedAt: number;
  readonly expiresAt: number;
};
export type WorkspaceWriteLeaseRegistry = {
  authenticate(credential: NativeBasicCredential): WorkspaceWriteLeaseScope | undefined;
  clear(): void;
  issue(scope: WorkspaceWriteLeaseScope): IssuedWorkspaceWriteLease;
};

export function createWorkspaceWriteLeaseRegistry(now: () => number): WorkspaceWriteLeaseRegistry {
  const leases = createNativeSignedLease("workspace-write-", leaseLifetimeMilliseconds, now);
  return {
    authenticate(credential) {
      const scope = leases.authenticate(credential);
      if (!fiveStrings(scope)) return;
      const [generationId, ownerHostId, projectId, repositoryId, workspaceId] = scope;
      return { generationId, ownerHostId, projectId, repositoryId, workspaceId };
    },
    clear: leases.clear,
    issue(scope) {
      return { ...scope, ...leases.issue([scope.generationId, scope.ownerHostId, scope.projectId, scope.repositoryId, scope.workspaceId]) };
    }
  };
}

function fiveStrings(value: readonly unknown[] | undefined): value is readonly [string, string, string, string, string] {
  return value?.length === 5 && value.every((entry) => typeof entry === "string");
}
