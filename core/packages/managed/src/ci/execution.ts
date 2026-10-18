import type { ExecutionEvent, ExecutionGrant, ExecutionProfile, ExecutionResult } from "@slop-lab/dim-native-git/execution";
export type { ExecutionEvent, ExecutionGrant, ExecutionProfile, ExecutionResult };
export type ExecutionPhase = "queued" | "assigned" | "running" | "recovering" | "finished";
export type Execution = {
  readonly id: string; readonly event: ExecutionEvent; readonly phase: ExecutionPhase;
  readonly generationId: string; readonly createdAt: number;
  readonly workerId?: string; readonly slotId?: string; readonly requestId?: string;
  readonly leaseToken?: string; readonly leaseExpiresAt?: number; readonly profile?: ExecutionProfile;
  readonly grant?: ExecutionGrant; readonly result?: ExecutionResult;
  readonly publication: "pending" | "accepted" | "stale";
};
export type ExecutionAssignment = Execution & { readonly workerId: string; readonly slotId: string;
  readonly requestId: string; readonly leaseToken: string; readonly leaseExpiresAt: number;
  readonly profile: ExecutionProfile };
export type WorkerSlot = { readonly id: string; readonly kind: ExecutionEvent["executionKind"]; readonly profile: ExecutionProfile };
export type WorkerIdentity = { readonly id: string; readonly token: string; readonly slots: readonly WorkerSlot[] };
export class ExecutionConflictError extends Error {}
