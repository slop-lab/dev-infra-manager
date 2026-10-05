import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseReviewObject, reviewObjectSchema, type ReviewObject } from "./review-schema.js";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const jobName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

export const MAX_REVIEW_EVENTS = 64;

export const nativeReviewJobEventSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal("dim.native.review-job.available"),
  eventId: z.string().uuid(),
  projectId: identifier,
  repositoryId: identifier,
  protectedRef: z.string(),
  reviewId: digest,
  expectedProtectedHead: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  policyRevision: z.string(),
  requiredReviewRevision: z.string(),
  requiredJobSetRevision: z.string(),
  jobName,
  evidenceClass: z.literal("candidate-controlled")
}).strict().readonly();

export const reviewEnvelopeSchema = z.object({
  review: reviewObjectSchema,
  events: z.array(nativeReviewJobEventSchema).min(1).max(MAX_REVIEW_EVENTS).readonly()
}).strict().readonly();

export type NativeReviewJobEvent = z.infer<typeof nativeReviewJobEventSchema>;
export type ReviewEnvelope = z.infer<typeof reviewEnvelopeSchema>;

export function createReviewEnvelope(review: ReviewObject): ReviewEnvelope {
  const events = review.requiredJobNames.map((requiredJobName) => nativeReviewJobEventSchema.parse({
    schemaVersion: 1,
    type: "dim.native.review-job.available",
    eventId: randomUUID(),
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
    jobName: requiredJobName,
    evidenceClass: "candidate-controlled"
  }));
  return parseReviewEnvelope({ review, events });
}

export function parseReviewEnvelope(input: unknown): ReviewEnvelope {
  const envelope = reviewEnvelopeSchema.parse(input);
  const review = parseReviewObject(envelope.review);
  const eventIds = new Set<string>();
  for (const event of envelope.events) {
    if (eventIds.has(event.eventId)) throw new ReviewEnvelopeError("review envelope contains a duplicate event ID");
    eventIds.add(event.eventId);
    if (event.projectId !== review.projectId || event.repositoryId !== review.repositoryId
      || event.protectedRef !== review.protectedRef || event.reviewId !== review.reviewId
      || event.expectedProtectedHead !== review.expectedProtectedHead || event.candidateCommit !== review.candidateCommit
      || event.candidateTree !== review.candidateTree || event.policyRevision !== review.policyRevision
      || event.requiredReviewRevision !== review.requiredReviewRevision
      || event.requiredJobSetRevision !== review.requiredJobSetRevision) {
      throw new ReviewEnvelopeError("review event tuple does not match its review");
    }
  }
  if (envelope.events.length !== review.requiredJobNames.length
    || envelope.events.some((event, index) => event.jobName !== review.requiredJobNames[index])) {
    throw new ReviewEnvelopeError("review envelope event set does not match its required jobs");
  }
  return { review, events: envelope.events };
}

export class ReviewEnvelopeError extends Error {
  readonly name = "ReviewEnvelopeError";
}
