import { z } from "zod";
import {
  mergeAuthorizationSchema,
  type MergeAuthorization,
} from "./model.js";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const attachment = z.object({ kind: z.string(), id: z.string(), digest }).strict().readonly();

export const dimLegacyMergeAuthorizationSchema = z.object({
  projectId: identifier,
  repositoryId: identifier,
  reviewId: digest,
  generationId: digest,
  envelopeId: digest,
  policyDigest: digest,
  protectedRef: z.string(),
  proposalRef: z.string(),
  expectedCommit: z.string(),
  candidateCommit: z.string(),
  candidateTree: z.string(),
  approvals: z.array(z.object({ reviewerId: identifier, recordDigest: digest }).strict()).readonly(),
  attachments: z.array(attachment).readonly(),
}).strict().readonly();

export type DimLegacyMergeAuthorization = z.infer<typeof dimLegacyMergeAuthorizationSchema>;

export function encodeDimLegacyMergeAuthorization(
  authorization: MergeAuthorization,
): DimLegacyMergeAuthorization {
  return dimLegacyMergeAuthorizationSchema.parse({
    projectId: authorization.namespaceId,
    repositoryId: authorization.repositoryId,
    reviewId: authorization.reviewId,
    generationId: authorization.authorityEpoch,
    envelopeId: authorization.envelopeId,
    policyDigest: authorization.policyDigest,
    protectedRef: authorization.protectedRef,
    proposalRef: authorization.proposalRef,
    expectedCommit: authorization.expectedCommit,
    candidateCommit: authorization.candidateCommit,
    candidateTree: authorization.candidateTree,
    approvals: authorization.approvals,
    attachments: authorization.attachments,
  });
}

export function decodeDimLegacyMergeAuthorization(input: unknown): MergeAuthorization {
  const authorization = dimLegacyMergeAuthorizationSchema.parse(input);
  return mergeAuthorizationSchema.parse({
    namespaceId: authorization.projectId,
    repositoryId: authorization.repositoryId,
    reviewId: authorization.reviewId,
    authorityEpoch: authorization.generationId,
    envelopeId: authorization.envelopeId,
    policyDigest: authorization.policyDigest,
    protectedRef: authorization.protectedRef,
    proposalRef: authorization.proposalRef,
    expectedCommit: authorization.expectedCommit,
    candidateCommit: authorization.candidateCommit,
    candidateTree: authorization.candidateTree,
    approvals: authorization.approvals,
    attachments: authorization.attachments,
  });
}
