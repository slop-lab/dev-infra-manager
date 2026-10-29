import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const attachment = z.object({ kind: z.string(), id: z.string(), digest }).strict().readonly();

export const mergeAuthorizationSchema = z.object({
  namespaceId: identifier,
  repositoryId: identifier,
  reviewId: digest,
  authorityEpoch: digest,
  envelopeId: digest,
  policyDigest: digest,
  protectedRef: z.string(),
  proposalRef: z.string(),
  expectedCommit: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  approvals: z.array(z.object({ reviewerId: identifier, recordDigest: digest }).strict()).readonly(),
  attachments: z.array(attachment).readonly(),
}).strict().readonly();

export const mergeAuthorizationRecoveryProofSchema = z.object({
  expectedTree: objectId,
  incarnationId: z.string().min(1),
  authorityEpoch: digest,
  ownerPrincipalId: z.string().min(1),
  refPolicyRevision: digest,
}).strict().readonly();

export type MergeAuthorization = z.infer<typeof mergeAuthorizationSchema>;
export type MergeAuthorizationRecoveryProof = z.infer<typeof mergeAuthorizationRecoveryProofSchema>;
export type StoredMergeAuthorization = {
  readonly authorizationId: string;
  readonly evidenceDigest: string;
  readonly authorization: MergeAuthorization;
  readonly recoveryProof?: MergeAuthorizationRecoveryProof;
  readonly sequence?: number;
};
