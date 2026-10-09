import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const mode = z.string().regex(/^[0-7]{6}$/);
const jobName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const base64 = z.string().refine((value) => Buffer.from(value, "base64").toString("base64") === value);
const stableWorkspaceId = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((value) =>
  Buffer.from(value, "base64url").length === 32 && Buffer.from(value, "base64url").toString("base64url") === value);

export const authoritativeNativeChangedPathSchema = z.object({
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "type-changed"]),
  oldPath: z.string().optional(),
  newPath: z.string().optional(),
  oldPathBytes: base64,
  newPathBytes: base64,
  oldMode: mode,
  newMode: mode,
  oldObjectId: objectId.or(z.literal("0")),
  newObjectId: objectId.or(z.literal("0")),
  similarity: z.number().int().min(0).max(100).optional(),
  oldSymlinkTarget: z.string().optional(),
  newSymlinkTarget: z.string().optional(),
  oldSymlinkTargetBytes: base64.optional(),
  newSymlinkTargetBytes: base64.optional()
}).strict().readonly();

export const authoritativeNativeRequiredJobSchema = z.object({
  executionKind: z.enum(["ordinary-sysbox", "qemu"]),
  jobName,
  evidenceClass: z.literal("candidate-controlled")
}).strict().readonly();

const identityObjectSchema = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.literal("native-main"),
  projectId: identifier,
  repositoryId: z.literal("root"),
  protectedRef: z.string(),
  proposalRef: z.string(),
  expectedProtectedHead: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  policyRevision: digest,
  requiredReviewRevision: digest,
  requiredJobSetRevision: digest,
  policyDigest: digest,
  workspaceId: stableWorkspaceId,
  requiredJobs: z.array(authoritativeNativeRequiredJobSchema).min(1).max(64).readonly(),
  requiredReviewerIds: z.array(identifier).min(1).readonly(),
  changes: z.array(authoritativeNativeChangedPathSchema).readonly(),
  patch: z.string(),
  patchBytes: base64
}).strict();

export const authoritativeNativeReviewSchema = identityObjectSchema.extend({
  reviewId: digest,
  createdAt: z.string().datetime()
}).strict().readonly();

export const authoritativeNativeReviewEventSchema = z.object({
  schemaVersion: z.literal(2),
  type: z.literal("dim.native.review-job.available"),
  eventId: digest,
  projectId: identifier,
  repositoryId: z.literal("root"),
  protectedRef: z.string(),
  reviewId: digest,
  expectedProtectedHead: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  policyRevision: digest,
  requiredReviewRevision: digest,
  requiredJobSetRevision: digest,
  executionKind: z.enum(["ordinary-sysbox", "qemu"]),
  jobName,
  evidenceClass: z.literal("candidate-controlled")
}).strict().readonly();

export const authoritativeNativeReviewEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  review: authoritativeNativeReviewSchema,
  events: z.array(authoritativeNativeReviewEventSchema).min(1).max(64).readonly()
}).strict().readonly();

export type AuthoritativeNativeChangedPath = z.infer<typeof authoritativeNativeChangedPathSchema>;
export type AuthoritativeNativeReviewIdentity = z.infer<typeof identityObjectSchema>;
export type AuthoritativeNativeReview = z.infer<typeof authoritativeNativeReviewSchema>;
export type AuthoritativeNativeReviewEnvelope = z.infer<typeof authoritativeNativeReviewEnvelopeSchema>;

export function authoritativeNativeReviewDigest(identity: AuthoritativeNativeReviewIdentity): string {
  return domainDigest("dim-native-authoritative-review-v1\0", identity);
}

export function createAuthoritativeNativeReviewEnvelope(
  identity: AuthoritativeNativeReviewIdentity,
  createdAt: string
): AuthoritativeNativeReviewEnvelope {
  assertSortedUnique(identity.requiredJobs.map(({ executionKind, jobName }) => `${executionKind}\0${jobName}`));
  assertSortedUnique(identity.requiredReviewerIds);
  const review = authoritativeNativeReviewSchema.parse({
    ...identity,
    reviewId: authoritativeNativeReviewDigest(identity),
    createdAt
  });
  const events = review.requiredJobs.map((job) => authoritativeNativeReviewEventSchema.parse({
    schemaVersion: 2,
    type: "dim.native.review-job.available",
    eventId: domainDigest("dim-native-authoritative-review-event-v1\0", {
      reviewId: review.reviewId,
      executionKind: job.executionKind,
      jobName: job.jobName
    }),
    projectId: review.projectId,
    repositoryId: review.repositoryId,
    protectedRef: review.protectedRef,
    reviewId: review.reviewId,
    expectedProtectedHead: review.expectedProtectedHead,
    candidateCommit: review.candidateCommit,
    candidateTree: review.candidateTree,
    policyRevision: review.policyRevision,
    requiredReviewRevision: review.requiredReviewRevision,
    requiredJobSetRevision: review.requiredJobSetRevision,
    ...job
  }));
  return parseAuthoritativeNativeReviewEnvelope({ schemaVersion: 1, review, events });
}

export function parseAuthoritativeNativeReviewEnvelope(input: unknown): AuthoritativeNativeReviewEnvelope {
  const envelope = authoritativeNativeReviewEnvelopeSchema.parse(input);
  const { reviewId, createdAt: _createdAt, ...identity } = envelope.review;
  assertSortedUnique(identity.requiredJobs.map(({ executionKind, jobName: name }) => `${executionKind}\0${name}`));
  assertSortedUnique(identity.requiredReviewerIds);
  if (!identity.proposalRef.startsWith(`refs/heads/proposals/${identity.workspaceId}/`)) {
    throw new AuthoritativeNativeReviewSchemaError("authoritative native review workspace binding is invalid");
  }
  if (authoritativeNativeReviewDigest(identity) !== reviewId) {
    throw new AuthoritativeNativeReviewSchemaError("authoritative native review digest is invalid");
  }
  const expected = createExpectedEvents(envelope.review);
  if (JSON.stringify(envelope.events) !== JSON.stringify(expected)) {
    throw new AuthoritativeNativeReviewSchemaError("authoritative native review event set is invalid");
  }
  return envelope;
}

function createExpectedEvents(review: AuthoritativeNativeReview): AuthoritativeNativeReviewEnvelope["events"] {
  return review.requiredJobs.map((job) => authoritativeNativeReviewEventSchema.parse({
    schemaVersion: 2,
    type: "dim.native.review-job.available",
    eventId: domainDigest("dim-native-authoritative-review-event-v1\0", {
      reviewId: review.reviewId,
      executionKind: job.executionKind,
      jobName: job.jobName
    }),
    projectId: review.projectId,
    repositoryId: review.repositoryId,
    protectedRef: review.protectedRef,
    reviewId: review.reviewId,
    expectedProtectedHead: review.expectedProtectedHead,
    candidateCommit: review.candidateCommit,
    candidateTree: review.candidateTree,
    policyRevision: review.policyRevision,
    requiredReviewRevision: review.requiredReviewRevision,
    requiredJobSetRevision: review.requiredJobSetRevision,
    ...job
  }));
}

function domainDigest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) canonical[key] = canonicalValue(Reflect.get(value, key));
  return canonical;
}

function assertSortedUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length || values.some((value, index) => {
    const previous = values[index - 1];
    return previous !== undefined && value <= previous;
  })) {
    throw new AuthoritativeNativeReviewSchemaError("authoritative native review set is not sorted and unique");
  }
}

export class AuthoritativeNativeReviewSchemaError extends Error {
  readonly name = "AuthoritativeNativeReviewSchemaError";
}
