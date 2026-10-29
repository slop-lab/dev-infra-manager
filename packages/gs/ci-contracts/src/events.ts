import { z } from "zod";
import { executionInputsSchema } from "./candidate-execution.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);

export const reviewCheckAvailableEventSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal("gs.review-check.available"),
  eventId: digest,
  envelopeId: digest,
  namespaceId: identifier,
  repositoryId: identifier,
  protectedRef: z.string(),
  reviewId: digest,
  expectedProtectedHead: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  policyRevision: digest,
  requiredReviewRevision: digest,
  qualityRevision: digest,
  provider: identifier,
  checkName: identifier,
  evidenceClass: z.literal("candidate-controlled"),
  inputs: executionInputsSchema,
}).strict().readonly();

export type ReviewCheckAvailableEvent = z.infer<typeof reviewCheckAvailableEventSchema>;
