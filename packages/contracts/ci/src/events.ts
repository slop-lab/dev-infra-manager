import { z } from "zod";
import { executionInputsSchema } from "./candidate-execution-schema.js";
const identifier=z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId=z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest=z.string().regex(/^[0-9a-f]{64}$/);
const jobName=z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

export const authoritativeNativeReviewEventSchema = z.object({
  schemaVersion: z.literal(3), type: z.literal("dim.native.review-job.available"), eventId: digest,
  envelopeId: digest, projectId: identifier, repositoryId: identifier, protectedRef: z.string(),
  reviewId: digest, expectedProtectedHead: objectId, candidateCommit: objectId, candidateTree: objectId,
  policyRevision: digest, requiredReviewRevision: digest, qualityRevision: digest,
  executionKind: z.enum(["ordinary-sysbox", "qemu"]), jobName, evidenceClass: z.literal("candidate-controlled"), inputs: executionInputsSchema
}).strict().readonly();
