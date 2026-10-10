import { z } from "zod";
import { descriptorDigest } from "./candidate-execution.js";
import {
  candidateOrdinaryExecutionDescriptorSchema,
  ordinaryExecutionDescriptorRequestFields
} from "./candidate-execution-schema.js";

const recordDigest = z.string().regex(/^[0-9a-f]{64}$/);
const descriptorDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const assignmentIdentifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);

export const authoritativeOrdinaryAttemptSchema = z.object({
  schemaVersion: z.literal(3),
  executionKind: z.literal("ordinary-sysbox"),
  issuanceRequestId: z.string().uuid(),
  attemptId: z.string().uuid(),
  reviewId: recordDigest,
  attempt: z.number().int().positive(),
  descriptor: candidateOrdinaryExecutionDescriptorSchema,
  descriptorDigest: descriptorDigestSchema,
  hostId: assignmentIdentifier,
  capacity: assignmentIdentifier,
  issuedBy: z.string().min(1),
  issuedAt: z.string().datetime()
}).strict().readonly().superRefine((attempt, context) => {
  if (descriptorDigest(attempt.descriptor) !== attempt.descriptorDigest) {
    context.addIssue({ code: "custom", message: "ordinary attempt descriptor digest is invalid",
      path: ["descriptorDigest"] });
  }
});

export const authoritativeOrdinaryAttemptRevocationSchema = z.object({
  schemaVersion: z.literal(3),
  executionKind: z.literal("ordinary-sysbox"),
  revocationRequestId: z.string().uuid(),
  revocationId: z.string().uuid(),
  attemptId: z.string().uuid(),
  reviewId: recordDigest,
  jobName: ordinaryExecutionDescriptorRequestFields.jobName,
  attempt: z.number().int().positive(),
  descriptorDigest: descriptorDigestSchema,
  hostId: assignmentIdentifier,
  capacity: assignmentIdentifier,
  revokedBy: z.string().min(1),
  revokedAt: z.string().datetime()
}).strict().readonly();

export type AuthoritativeOrdinaryAttempt = z.infer<typeof authoritativeOrdinaryAttemptSchema>;
export type AuthoritativeOrdinaryAttemptRevocation = z.infer<
  typeof authoritativeOrdinaryAttemptRevocationSchema
>;
