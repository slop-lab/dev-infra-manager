import { z } from "zod";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const workflowProviderSchema = z.object({
  name: identifier,
  revision: digest,
}).strict().readonly();

export type WorkflowProviderIdentity = z.infer<typeof workflowProviderSchema>;

export const ciExecutionEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  provider: identifier,
  providerRevision: digest,
  eventId: digest,
  reviewId: digest,
  envelopeId: digest,
  candidateCommit: objectId,
  candidateTree: objectId,
  policyDigest: digest,
  outcome: z.enum(["succeeded", "failed"]),
  evidenceId: z.string().min(1).max(256),
  digest,
}).strict().readonly();

export type CiExecutionEvidence = z.infer<typeof ciExecutionEvidenceSchema>;
