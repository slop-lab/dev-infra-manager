import { DatabaseSync } from "node:sqlite";
import {
  finalizedProtectedRef,
  protectedRefIntentMatchesQuery,
  type JournalPort,
  type ProtectedRefIntent,
} from "@slop-lab/gs-repository";
import { readNativeProjectRootImportsFromDatabase } from "./native-project-root-import-transitions.js";
import {
  assertRepositoryRefTransitions,
  cancelRepositoryRefIntent,
  finalizeRepositoryRef,
  readRepositoryRefTransitions,
  saveRepositoryRefIntent,
  type RepositoryRefTransition,
} from "./repository-ref-state.js";

export function createDimJournalPort(databasePath: string): JournalPort {
  return {
    findFinalized(change, protectedRef) {
      const entry = readFinalized(databasePath, {
        namespaceId: change.namespaceId,
        repositoryId: change.repositoryId,
        authorizationId: change.authorizationId,
        protectedRef,
      });
      return entry === undefined ? undefined : finalizedProtectedRef(fromDimIntent(databasePath, entry));
    },
    findFinalizedExact(query) {
      const entry = readFinalized(databasePath, query);
      if (entry === undefined) return undefined;
      const intent = fromDimIntent(databasePath, entry);
      return protectedRefIntentMatchesQuery(intent, query) ? finalizedProtectedRef(intent) : undefined;
    },
    appendIntent(intent) { saveRepositoryRefIntent(databasePath, toDimIntent(intent)); },
    finalize(intent) { finalizeRepositoryRef(databasePath, toDimIntent(intent)); },
    cancel(intent) { cancelRepositoryRefIntent(databasePath, toDimIntent(intent)); },
    pending() {
      const database = new DatabaseSync(databasePath, { readOnly: true, defensive: true });
      try {
        assertRepositoryRefTransitions(database);
        return readRepositoryRefTransitions(database)
          .filter((entry) => !entry.finalized)
          .map((entry) => fromDimIntent(databasePath, entry.transition));
      } finally {
        database.close();
      }
    },
  };
}

function readFinalized(databasePath: string, selector: {
  readonly namespaceId: string;
  readonly repositoryId: string;
  readonly authorizationId: string;
  readonly protectedRef: string;
}): RepositoryRefTransition | undefined {
  const database = new DatabaseSync(databasePath, { readOnly: true, defensive: true });
  try {
    return readRepositoryRefTransitions(database).find(({ transition, finalized }) => finalized
      && transition.projectId === selector.namespaceId && transition.repositoryId === selector.repositoryId
      && transition.authorizationId === selector.authorizationId && transition.protectedRef === selector.protectedRef)?.transition;
  } finally {
    database.close();
  }
}

function toDimIntent(intent: ProtectedRefIntent): RepositoryRefTransition {
  return {
    projectId: intent.namespaceId,
    repositoryId: intent.repositoryId,
    sequence: intent.sequence,
    importNonce: intent.incarnationId,
    protectedRef: intent.protectedRef,
    proposalRef: intent.proposalRef,
    expectedCommit: intent.expectedCommit,
    expectedTree: intent.expectedTree,
    candidateCommit: intent.candidateCommit,
    candidateTree: intent.candidateTree,
    generationId: intent.authorityEpoch,
    policyDigest: intent.policyDigest,
    refPolicyRevision: intent.refPolicyRevision,
    authorizationId: intent.authorizationId,
    evidenceDigest: intent.evidenceDigest,
  };
}

function fromDimIntent(databasePath: string, transition: RepositoryRefTransition): ProtectedRefIntent {
  return {
    namespaceId: transition.projectId,
    repositoryId: transition.repositoryId,
    sequence: transition.sequence,
    protectedRef: transition.protectedRef,
    proposalRef: transition.proposalRef,
    expectedCommit: transition.expectedCommit,
    expectedTree: transition.expectedTree,
    candidateCommit: transition.candidateCommit,
    candidateTree: transition.candidateTree,
    authorizationId: transition.authorizationId,
    evidenceDigest: transition.evidenceDigest,
    incarnationId: transition.importNonce,
    authorityEpoch: transition.generationId,
    policyDigest: transition.policyDigest,
    ownerPrincipalId: ownerPrincipalId(databasePath, transition),
    refPolicyRevision: transition.refPolicyRevision,
  };
}

function ownerPrincipalId(databasePath: string, transition: RepositoryRefTransition): string {
  const imported = readNativeProjectRootImportsFromDatabase(databasePath).find((entry) => entry.phase === "repository-imported"
    && entry.projectId === transition.projectId && entry.repositoryId === transition.repositoryId
    && entry.importNonce === transition.importNonce);
  if (imported === undefined) throw new Error("DIM repository transition has no authoritative owner");
  return imported.ownerHostId;
}
