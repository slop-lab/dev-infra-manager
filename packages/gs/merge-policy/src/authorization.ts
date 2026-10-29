import type { ProtectedRefFinalizedQuery } from "@slop-lab/gs-repository";
import type { RefUpdatePolicy, RepositoryTarget } from "@slop-lab/gs-repository-service";
import type { MergePromotionResult } from "./feature.js";
import type { MergeAuthorization, StoredMergeAuthorization } from "./state.js";

export function promotionResult(
  outcome: MergePromotionResult["outcome"],
  authorization: MergeAuthorization,
  sequence: number,
): MergePromotionResult {
  return {
    schemaVersion: 1,
    outcome,
    reviewId: authorization.reviewId,
    protectedRef: authorization.protectedRef,
    expectedProtectedHead: authorization.expectedCommit,
    candidateCommit: authorization.candidateCommit,
    candidateTree: authorization.candidateTree,
    sequence,
  };
}

export function assertTargetProof(
  expected: Parameters<RefUpdatePolicy["authorize"]>[0]["target"],
  current: RepositoryTarget,
): void {
  if (expected.repositoryPath !== current.repositoryPath || expected.incarnationId !== current.incarnationId
    || expected.authorityEpoch !== current.authorityEpoch || expected.policyDigest !== current.policyDigest
    || expected.ownerPrincipalId !== current.ownerPrincipalId || expected.refPolicyRevision !== current.refPolicyRevision
    || expected.head.sequence !== current.head.sequence || expected.head.commit !== current.head.commit
    || expected.head.tree !== current.head.tree || expected.head.protectedRef !== current.head.protectedRef) {
    throw new MergeAuthorizationError("repository target changed during merge authorization");
  }
}

export function mergeFinalizedQuery(entry: StoredMergeAuthorization): ProtectedRefFinalizedQuery | undefined {
  const proof = entry.recoveryProof;
  if (proof === undefined) return undefined;
  const authorization = entry.authorization;
  return {
    namespaceId: authorization.namespaceId,
    repositoryId: authorization.repositoryId,
    protectedRef: authorization.protectedRef,
    proposalRef: authorization.proposalRef,
    expectedCommit: authorization.expectedCommit,
    expectedTree: proof.expectedTree,
    candidateCommit: authorization.candidateCommit,
    candidateTree: authorization.candidateTree,
    authorizationId: entry.authorizationId,
    evidenceDigest: entry.evidenceDigest,
    incarnationId: proof.incarnationId,
    authorityEpoch: proof.authorityEpoch,
    policyDigest: authorization.policyDigest,
    ownerPrincipalId: proof.ownerPrincipalId,
    refPolicyRevision: proof.refPolicyRevision,
  };
}

export class MergeAuthorizationError extends Error {
  readonly name = "MergeAuthorizationError";
}
