export type SchedulingEvent = { readonly eventId: string; readonly executionKind: string };
export type SchedulingGrant = { readonly executionId: string; readonly descriptorDigest: string };
export type SchedulingResult = { readonly executionId: string; readonly descriptorDigest: string };
export type ScheduledJob<E extends SchedulingEvent, P extends object, G extends SchedulingGrant, R extends SchedulingResult> = {
  id: string; event: E; generationId: string; createdAt: number;
  phase: "queued" | "assigned" | "running" | "recovering" | "finished";
  workerId?: string | undefined; slotId?: string | undefined; requestId?: string | undefined;
  leaseToken?: string | undefined; leaseExpiresAt?: number | undefined;
  profile?: P | undefined; grant?: G | undefined; result?: R | undefined;
  retryOf?: string | undefined; retryRequestId?: string | undefined; cancelRequestedAt?: number | undefined;
  publication: "pending" | "accepted" | "stale";
};
export type AssignmentOwnership<P extends object> = { readonly workerId: string; readonly slotId: string;
  readonly requestId: string; readonly leaseToken: string; readonly leaseExpiresAt: number; readonly profile: P };
export type ScheduledAssignment<E extends SchedulingEvent, P extends object, G extends SchedulingGrant, R extends SchedulingResult> = ScheduledJob<E, P, G, R> & AssignmentOwnership<P>;
export type ScheduledSlot<P extends object> = { readonly id: string; readonly kind: string; readonly profile: P };
export class ExecutionConflictError extends Error {}
