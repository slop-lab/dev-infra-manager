export type NativeQemuReviewEvent = {
  readonly schemaVersion: 2;
  readonly type: "dim.native.review-job.available";
  readonly eventId: string;
  readonly projectId: string;
  readonly repositoryId: "root";
  readonly protectedRef: string;
  readonly reviewId: string;
  readonly expectedProtectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly policyRevision: string;
  readonly requiredReviewRevision: string;
  readonly requiredJobSetRevision: string;
  readonly executionKind: "qemu";
  readonly jobName: string;
  readonly evidenceClass: "candidate-controlled";
};

const eventFields = ["schemaVersion", "type", "eventId", "projectId", "repositoryId", "protectedRef",
  "reviewId", "expectedProtectedHead", "candidateCommit", "candidateTree", "policyRevision",
  "requiredReviewRevision", "requiredJobSetRevision", "executionKind", "jobName", "evidenceClass"] as const;

export function parseNativeQemuReviewEvent(value: unknown): NativeQemuReviewEvent {
  const event = exactRecord(value, eventFields);
  if (event.schemaVersion !== 2 || event.type !== "dim.native.review-job.available"
    || event.repositoryId !== "root" || event.executionKind !== "qemu"
    || event.evidenceClass !== "candidate-controlled") invalid();
  return {
    schemaVersion: 2,
    type: "dim.native.review-job.available",
    eventId: matching(event.eventId, /^[0-9a-f]{64}$/),
    projectId: matching(event.projectId, /^[a-z][a-z0-9-]{0,62}$/),
    repositoryId: "root",
    protectedRef: headRef(event.protectedRef),
    reviewId: matching(event.reviewId, /^[0-9a-f]{64}$/),
    expectedProtectedHead: matching(event.expectedProtectedHead, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    candidateCommit: matching(event.candidateCommit, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    candidateTree: matching(event.candidateTree, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    policyRevision: revision(event.policyRevision),
    requiredReviewRevision: revision(event.requiredReviewRevision),
    requiredJobSetRevision: revision(event.requiredJobSetRevision),
    executionKind: "qemu",
    jobName: matching(event.jobName, /^[a-z][a-z0-9-]{0,62}$/),
    evidenceClass: "candidate-controlled"
  };
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) invalid();
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)]));
}

function matching(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}

function revision(value: unknown): string {
  return matching(value, /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/);
}

function headRef(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024 || !value.startsWith("refs/heads/")
    || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock") || value.includes("..")
    || value.includes("@{") || value.includes("\\") || /[\x00-\x20\x7f~^:?*[\]]/.test(value)
    || !value.slice("refs/heads/".length).split("/").every((part) => part.length > 0 && !part.startsWith("."))) invalid();
  return value;
}

function invalid(): never {
  throw new NativeQemuReviewEventError("native QEMU review event is invalid");
}

export class NativeQemuReviewEventError extends Error {
  readonly name = "NativeQemuReviewEventError";
}
