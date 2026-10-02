import { z } from "zod";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

export const jobAttemptSchema = z.object({
  schemaVersion: z.literal(1),
  attemptId: z.string().uuid(),
  reviewId: digest,
  projectId: identifier,
  repositoryId: identifier,
  jobName: identifier,
  attempt: z.number().int().positive(),
  issuedBy: z.string().min(1),
  issuedAt: z.string().datetime()
}).strict().readonly();

export const jobAttemptRevocationSchema = z.object({
  schemaVersion: z.literal(1),
  revocationId: z.string().uuid(),
  attemptId: z.string().uuid(),
  reviewId: digest,
  jobName: identifier,
  attempt: z.number().int().positive(),
  revokedBy: z.string().min(1),
  revokedAt: z.string().datetime()
}).strict().readonly();

export type JobAttempt = z.infer<typeof jobAttemptSchema>;
export type JobAttemptRevocation = z.infer<typeof jobAttemptRevocationSchema>;
