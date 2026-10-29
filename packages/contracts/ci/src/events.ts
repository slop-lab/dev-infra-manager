import { z } from "zod";
import { executionInputsSchema, reviewCheckAvailableEventSchema,
  type ReviewCheckAvailableEvent } from "@slop-lab/gs-ci-contracts";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const jobName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

export const dimReviewJobAvailableEventSchema = z.object({
  schemaVersion: z.literal(3),
  type: z.literal("dim.native.review-job.available"),
  eventId: digest,
  envelopeId: digest,
  projectId: identifier,
  repositoryId: identifier,
  protectedRef: z.string(),
  reviewId: digest,
  expectedProtectedHead: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  policyRevision: digest,
  requiredReviewRevision: digest,
  qualityRevision: digest,
  executionKind: z.enum(["ordinary-sysbox", "qemu"]),
  jobName,
  evidenceClass: z.literal("candidate-controlled"),
  inputs: executionInputsSchema,
}).strict().readonly();

export type DimReviewJobAvailableEvent = z.infer<typeof dimReviewJobAvailableEventSchema>;

export function encodeDimReviewJobAvailableEvent(event: ReviewCheckAvailableEvent): DimReviewJobAvailableEvent {
  return dimReviewJobAvailableEventSchema.parse({
    schemaVersion: 3,
    type: "dim.native.review-job.available",
    eventId: event.eventId,
    envelopeId: event.envelopeId,
    projectId: event.namespaceId,
    repositoryId: event.repositoryId,
    protectedRef: event.protectedRef,
    reviewId: event.reviewId,
    expectedProtectedHead: event.expectedProtectedHead,
    candidateCommit: event.candidateCommit,
    candidateTree: event.candidateTree,
    policyRevision: event.policyRevision,
    requiredReviewRevision: event.requiredReviewRevision,
    qualityRevision: event.qualityRevision,
    executionKind: event.provider,
    jobName: event.checkName,
    evidenceClass: event.evidenceClass,
    inputs: event.inputs,
  });
}

export function decodeDimReviewJobAvailableEvent(input: unknown): ReviewCheckAvailableEvent {
  const event = dimReviewJobAvailableEventSchema.parse(input);
  return reviewCheckAvailableEventSchema.parse({
    schemaVersion: 1,
    type: "gs.review-check.available",
    eventId: event.eventId,
    envelopeId: event.envelopeId,
    namespaceId: event.projectId,
    repositoryId: event.repositoryId,
    protectedRef: event.protectedRef,
    reviewId: event.reviewId,
    expectedProtectedHead: event.expectedProtectedHead,
    candidateCommit: event.candidateCommit,
    candidateTree: event.candidateTree,
    policyRevision: event.policyRevision,
    requiredReviewRevision: event.requiredReviewRevision,
    qualityRevision: event.qualityRevision,
    provider: event.executionKind,
    checkName: event.jobName,
    evidenceClass: event.evidenceClass,
    inputs: event.inputs,
  });
}

export const dimReviewJobAvailableEventCodec = {
  serialize: (event: ReviewCheckAvailableEvent) => JSON.stringify(encodeDimReviewJobAvailableEvent(event)),
};
