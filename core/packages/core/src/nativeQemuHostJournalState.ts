import { nativeQemuDescriptorDigest, parseNativeQemuDescriptor,
  type NativeQemuHostAssignment } from "./nativeQemuAssignment.js";
import { parseNativeQemuReviewEvent } from "./nativeQemuReviewEvent.js";
import { parseNativeQemuTerminalEvent } from "./nativeQemuTerminalEvent.js";

export type NativeQemuHostJournalState =
  | { readonly kind: "claim"; readonly requestId: string }
  | { readonly kind: "active"; readonly assignment: NativeQemuHostAssignment }
  | { readonly kind: "result"; readonly claimId: string;
    readonly terminalEvent: Readonly<Record<string, unknown>> };

export function parseNativeQemuHostJournalState(value: unknown): NativeQemuHostJournalState {
  const record = exactRecord(value);
  if (record.schemaVersion !== 1) invalid("journal fields are invalid");
  if (record.kind === "claim") {
    exactKeys(record, ["schemaVersion", "kind", "requestId"]);
    return { kind: "claim", requestId: uuid(record.requestId) };
  }
  if (record.kind === "active") {
    exactKeys(record, ["schemaVersion", "kind", "assignment"]);
    const assignment = exactRecord(record.assignment);
    exactKeys(assignment, ["claim", "attempt"]);
    const claim = exactRecord(assignment.claim);
    const attempt = exactRecord(assignment.attempt);
    exactKeys(claim, ["claimId", "requestId", "hostId", "capacity", "admissionGeneration", "leaseExpiresAt", "event"]);
    const claimId = uuid(claim.claimId);
    const requestId = uuid(claim.requestId);
    const hostId = identifier(claim.hostId);
    const capacity = identifier(claim.capacity);
    const admissionGeneration = generation(claim.admissionGeneration);
    const leaseExpiresAt = safeInteger(claim.leaseExpiresAt);
    const event = parseNativeQemuReviewEvent(claim.event);
    const attemptId = uuid(attempt.attemptId);
    const descriptorDigest = digest(attempt.descriptorDigest);
    const descriptor = parseNativeQemuDescriptor(attempt.descriptor);
    if (nativeQemuDescriptorDigest(descriptor) !== descriptorDigest
      || descriptor.admissionGeneration !== admissionGeneration || descriptor.jobName !== event.jobName
      || descriptor.projectId !== event.projectId || descriptor.repositoryId !== event.repositoryId
      || descriptor.protectedRef !== event.protectedRef || descriptor.expectedProtectedHead !== event.expectedProtectedHead
      || descriptor.candidateCommit !== event.candidateCommit || descriptor.candidateTree !== event.candidateTree
      || descriptor.policyRevision !== event.policyRevision
      || descriptor.requiredReviewRevision !== event.requiredReviewRevision
      || descriptor.requiredJobSetRevision !== event.qualityRevision
      || descriptor.evidenceClass !== event.evidenceClass) invalid("journal assignment is inconsistent");
    return { kind: "active", assignment: {
      claim: { claimId, requestId, hostId, capacity, admissionGeneration, leaseExpiresAt, event },
      attempt: { attemptId, descriptorDigest, descriptor }
    } };
  }
  if (record.kind === "result") {
    exactKeys(record, ["schemaVersion", "kind", "claimId", "terminalEvent"]);
    return { kind: "result", claimId: uuid(record.claimId), terminalEvent: parseNativeQemuTerminalEvent(record.terminalEvent) };
  }
  return invalid("journal kind is invalid");
}

function uuid(value: unknown): string {
  if (typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    invalid("journal fields are invalid");
  }
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) invalid("journal fields are invalid");
  return value;
}
function generation(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) invalid("journal fields are invalid");
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) invalid("journal fields are invalid");
  return value;
}
function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid("journal fields are invalid");
  return value;
}
function exactRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("journal record is invalid");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}
function exactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    invalid("journal fields are invalid");
  }
}
function invalid(message: string): never { throw new NativeQemuHostJournalError(`native QEMU host ${message}`); }
export class NativeQemuHostJournalError extends Error { readonly name = "NativeQemuHostJournalError"; }
