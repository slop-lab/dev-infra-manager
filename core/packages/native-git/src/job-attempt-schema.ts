import { z } from "zod";
import { descriptorDigest } from "./candidate-execution.js";
import {
  candidateOrdinaryExecutionDescriptorSchema,
  ordinaryExecutionDescriptorRequestFields
} from "./candidate-execution-schema.js";

const reviewDigest = z.string().regex(/^[0-9a-f]{64}$/);
const descriptorDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const assignmentIdentifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);

export const issueJobRequestSchema = z.object({
  ...ordinaryExecutionDescriptorRequestFields,
  issuanceRequestId: z.string().uuid(),
  descriptorDigest: descriptorDigestSchema,
  hostId: assignmentIdentifier,
  capacity: assignmentIdentifier
}).strict().readonly();

export const jobAttemptSchema = z.object({
  schemaVersion: z.literal(2),
  issuanceRequestId: z.string().uuid(),
  attemptId: z.string().uuid(),
  reviewId: reviewDigest,
  attempt: z.number().int().positive(),
  descriptor: candidateOrdinaryExecutionDescriptorSchema,
  descriptorDigest: descriptorDigestSchema,
  hostId: assignmentIdentifier,
  capacity: assignmentIdentifier,
  issuedBy: z.string().min(1),
  issuedAt: z.string().datetime()
}).strict().readonly().superRefine((attempt, context) => {
  if (descriptorDigest(attempt.descriptor) !== attempt.descriptorDigest) {
    context.addIssue({ code: "custom", message: "job attempt descriptor digest is invalid", path: ["descriptorDigest"] });
  }
});

export const jobAttemptRevocationSchema = z.object({
  schemaVersion: z.literal(2),
  revocationId: z.string().uuid(),
  attemptId: z.string().uuid(),
  reviewId: reviewDigest,
  jobName: ordinaryExecutionDescriptorRequestFields.jobName,
  attempt: z.number().int().positive(),
  descriptorDigest: descriptorDigestSchema,
  hostId: assignmentIdentifier,
  capacity: assignmentIdentifier,
  revokedBy: z.string().min(1),
  revokedAt: z.string().datetime()
}).strict().readonly();

export type IssueJobRequest = z.infer<typeof issueJobRequestSchema>;
export type JobAttempt = z.infer<typeof jobAttemptSchema>;
export type JobAttemptRevocation = z.infer<typeof jobAttemptRevocationSchema>;
