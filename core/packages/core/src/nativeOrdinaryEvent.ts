import { createHash } from "node:crypto";
import { UserError } from "./errors.js";
import { record } from "./nativeOrdinaryAuthorityModel.js";

export type NativeReviewJobEvent = {
  readonly schemaVersion: 1;
  readonly type: "dim.native.review-job.available";
  readonly eventId: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly protectedRef: string;
  readonly reviewId: string;
  readonly expectedProtectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly policyRevision: string;
  readonly requiredReviewRevision: string;
  readonly requiredJobSetRevision: string;
  readonly jobName: string;
  readonly evidenceClass: "candidate-controlled";
};

const eventKeys = [
  "schemaVersion", "type", "eventId", "projectId", "repositoryId", "protectedRef", "reviewId",
  "expectedProtectedHead", "candidateCommit", "candidateTree", "policyRevision", "requiredReviewRevision",
  "requiredJobSetRevision", "jobName", "evidenceClass"
] as const;

export function parseNativeReviewJobEvent(value: unknown): NativeReviewJobEvent {
  const input = record(value);
  if (Object.keys(input).length !== eventKeys.length || eventKeys.some((key) => input[key] === undefined)) {
    throw new UserError("native review-job event has invalid fields");
  }
  if (input.schemaVersion !== 1 || input.type !== "dim.native.review-job.available"
    || input.evidenceClass !== "candidate-controlled") {
    throw new UserError("native review-job event contract is invalid");
  }
  return {
    schemaVersion: 1,
    type: "dim.native.review-job.available",
    eventId: text(input.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "event ID"),
    projectId: text(input.projectId, /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, "Project ID"),
    repositoryId: text(input.repositoryId, /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, "repository ID"),
    protectedRef: protectedRef(input.protectedRef),
    reviewId: text(input.reviewId, /^[0-9a-f]{64}$/, "review ID"),
    expectedProtectedHead: objectId(input.expectedProtectedHead),
    candidateCommit: objectId(input.candidateCommit),
    candidateTree: objectId(input.candidateTree),
    policyRevision: revision(input.policyRevision, "policy revision"),
    requiredReviewRevision: revision(input.requiredReviewRevision, "review revision"),
    requiredJobSetRevision: revision(input.requiredJobSetRevision, "job-set revision"),
    jobName: text(input.jobName, /^[a-z][a-z0-9-]{0,62}$/, "job name"),
    evidenceClass: "candidate-controlled"
  };
}

export function canonicalNativeEvent(event: NativeReviewJobEvent): string {
  return JSON.stringify(event);
}

export function nativeEventDigest(event: NativeReviewJobEvent): string {
  return `sha256:${createHash("sha256").update(canonicalNativeEvent(event), "utf8").digest("hex")}`;
}

export function nativeReviewJobTupleDigest(event: NativeReviewJobEvent): string {
  const fields = [
    event.projectId, event.repositoryId, event.protectedRef, event.reviewId, event.expectedProtectedHead,
    event.candidateCommit, event.candidateTree, event.policyRevision, event.requiredReviewRevision,
    event.requiredJobSetRevision, event.jobName, event.evidenceClass
  ];
  const hash = createHash("sha256").update("dim-native-review-job-tuple-v1", "ascii");
  for (const field of fields) hash.update(`${Buffer.byteLength(field, "utf8")}:`, "ascii").update(field, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new UserError(`${label} is invalid`);
  return value;
}

function revision(value: unknown, label: string): string {
  return text(value, /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/, label);
}

function objectId(value: unknown): string {
  return text(value, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "object ID");
}

function protectedRef(value: unknown): string {
  const ref = text(value, /^refs\/heads\/.+$/, "protected ref");
  if (ref.endsWith("/") || ref.endsWith(".") || ref.endsWith(".lock") || ref.includes("..") || ref.includes("@{")
    || /[\\\x00-\x20\x7f~^:?*[\]]/.test(ref)) throw new UserError("protected ref is invalid");
  return ref;
}
