import { createHash } from "node:crypto";

const digestPattern = /^[0-9a-f]{64}$/;
const objectPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const identifierPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const jobPattern = /^[a-z][a-z0-9-]{0,62}$/;
const fields = ["schemaVersion", "type", "eventId", "projectId", "repositoryId", "protectedRef",
  "reviewId", "expectedProtectedHead", "candidateCommit", "candidateTree", "policyRevision",
  "requiredReviewRevision", "requiredJobSetRevision", "executionKind", "jobName", "evidenceClass"] as const;

export type NativeRootCiReviewEvent = {
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
  readonly executionKind: "ordinary-sysbox";
  readonly jobName: string;
  readonly evidenceClass: "candidate-controlled";
};

export function parseNativeRootCiReviewEvent(value: unknown): NativeRootCiReviewEvent {
  const event = exactRecord(value);
  if (event.schemaVersion !== 2 || event.type !== "dim.native.review-job.available"
    || !isDigest(event.eventId) || typeof event.projectId !== "string" || !identifierPattern.test(event.projectId)
    || event.repositoryId !== "root" || typeof event.protectedRef !== "string" || !safeProtectedRef(event.protectedRef)
    || !isDigest(event.reviewId) || !isObjectId(event.expectedProtectedHead) || !isObjectId(event.candidateCommit)
    || !isObjectId(event.candidateTree) || event.candidateCommit.length !== event.expectedProtectedHead.length
    || event.candidateTree.length !== event.expectedProtectedHead.length || !isDigest(event.policyRevision)
    || !isDigest(event.requiredReviewRevision) || !isDigest(event.requiredJobSetRevision)
    || event.executionKind !== "ordinary-sysbox" || typeof event.jobName !== "string"
    || !jobPattern.test(event.jobName) || event.evidenceClass !== "candidate-controlled"
    || event.eventId !== reviewEventId(event.reviewId, event.jobName)) invalid();
  return { schemaVersion: 2, type: "dim.native.review-job.available", eventId: event.eventId,
    projectId: event.projectId, repositoryId: "root", protectedRef: event.protectedRef,
    reviewId: event.reviewId, expectedProtectedHead: event.expectedProtectedHead,
    candidateCommit: event.candidateCommit, candidateTree: event.candidateTree,
    policyRevision: event.policyRevision, requiredReviewRevision: event.requiredReviewRevision,
    requiredJobSetRevision: event.requiredJobSetRevision, executionKind: "ordinary-sysbox",
    jobName: event.jobName, evidenceClass: "candidate-controlled" };
}

export function canonicalNativeRootCiReviewEvent(event: NativeRootCiReviewEvent): string {
  return JSON.stringify(event);
}

function exactRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) invalid();
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)]));
}

function reviewEventId(reviewId: string, jobName: string): string {
  return createHash("sha256").update("dim-native-authoritative-review-event-v1\0")
    .update(JSON.stringify({ executionKind: "ordinary-sysbox", jobName, reviewId })).digest("hex");
}

function safeProtectedRef(value: string): boolean {
  return value.startsWith("refs/heads/") && !value.startsWith("refs/heads/proposals/") && !value.endsWith("/")
    && !value.endsWith(".") && !value.endsWith(".lock") && !value.includes("..") && !value.includes("@{")
    && !value.includes("\\") && !/[\x00-\x20\x7f~^:?*[\]]/.test(value)
    && value.slice("refs/heads/".length).split("/").every((part) => part.length > 0 && !part.startsWith("."));
}

function isDigest(value: unknown): value is string { return typeof value === "string" && digestPattern.test(value); }
function isObjectId(value: unknown): value is string { return typeof value === "string" && objectPattern.test(value); }
function invalid(): never { throw new NativeRootCiReviewEventError(); }

export class NativeRootCiReviewEventError extends Error {
  readonly name = "NativeRootCiReviewEventError";
}
