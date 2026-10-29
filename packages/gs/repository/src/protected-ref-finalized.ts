import type {
  ProtectedRefChange,
  ProtectedRefIntent,
  ProtectedRefReceipt,
  ProtectedRefTarget,
} from "./protected-ref.js";
import type { ProtectedRefFinalizedQuery } from "./protected-ref-validation.js";

export type { ProtectedRefFinalizedQuery } from "./protected-ref-validation.js";

export type ProtectedRefFinalized = {
  readonly intent: ProtectedRefIntent;
  readonly receipt: ProtectedRefReceipt & { readonly outcome: "promoted" };
};

export function createProtectedRefFinalizedQuery(
  change: ProtectedRefChange,
  target: ProtectedRefTarget,
): ProtectedRefFinalizedQuery {
  return {
    namespaceId: change.namespaceId,
    repositoryId: change.repositoryId,
    protectedRef: target.head.protectedRef,
    proposalRef: change.proposalRef,
    expectedCommit: change.expectedCommit,
    expectedTree: target.head.tree,
    candidateCommit: change.candidateCommit,
    candidateTree: change.candidateTree,
    authorizationId: change.authorizationId,
    evidenceDigest: change.evidenceDigest,
    incarnationId: target.incarnationId,
    authorityEpoch: target.authorityEpoch,
    policyDigest: target.policyDigest,
    ownerPrincipalId: target.ownerPrincipalId,
    refPolicyRevision: target.refPolicyRevision,
  };
}

export function protectedRefIntentMatchesQuery(
  intent: ProtectedRefIntent,
  query: ProtectedRefFinalizedQuery,
): boolean {
  return intent.namespaceId === query.namespaceId && intent.repositoryId === query.repositoryId
    && intent.protectedRef === query.protectedRef && intent.proposalRef === query.proposalRef
    && intent.expectedCommit === query.expectedCommit && intent.expectedTree === query.expectedTree
    && intent.candidateCommit === query.candidateCommit && intent.candidateTree === query.candidateTree
    && intent.authorizationId === query.authorizationId && intent.evidenceDigest === query.evidenceDigest
    && intent.incarnationId === query.incarnationId && intent.authorityEpoch === query.authorityEpoch
    && intent.policyDigest === query.policyDigest && intent.ownerPrincipalId === query.ownerPrincipalId
    && intent.refPolicyRevision === query.refPolicyRevision;
}

export function finalizedProtectedRef(intent: ProtectedRefIntent): ProtectedRefFinalized {
  return { intent, receipt: { outcome: "promoted", sequence: intent.sequence } };
}
