import type { DatabaseSync } from "node:sqlite";
import { finalizedProtectedRef, protectedRefIntentMatchesQuery, type JournalPort } from "@slop-lab/gs-repository";
import type { RepositoryStateIntegrityBoundary } from "./integrity-boundary.js";
import { RepositoryStateError, transaction } from "./state.js";
import { assertIntentCanAppend } from "./state-validation.js";
import { readFinalizedByAuthorization, readPendingTransitions, readTransitionById, transitionId } from "./transition-store.js";

export function createJournalPort(database: DatabaseSync, integrity: RepositoryStateIntegrityBoundary): JournalPort {
  return {
    findFinalized(change, protectedRef) {
      integrity.assertUnchanged();
      const entry = readFinalizedByAuthorization(database, { namespaceId: change.namespaceId,
        repositoryId: change.repositoryId, authorizationId: change.authorizationId, protectedRef })[0];
      return entry === undefined ? undefined : finalizedProtectedRef(entry.intent);
    },
    findFinalizedExact(query) {
      integrity.assertUnchanged();
      const entry = readFinalizedByAuthorization(database, query)
        .find(({ intent }) => protectedRefIntentMatchesQuery(intent, query));
      return entry === undefined ? undefined : finalizedProtectedRef(entry.intent);
    },
    appendIntent(intent) {
      transaction(database, () => {
        integrity.assertUnchanged();
        assertIntentCanAppend(database, intent);
        database.prepare("INSERT INTO repository_ref_transition(namespace_id,repository_id,sequence,protected_ref,authorization_id,transition_id,record_json,finalized) VALUES(?,?,?,?,?,?,?,0)").run(
          intent.namespaceId,
          intent.repositoryId,
          intent.sequence,
          intent.protectedRef,
          intent.authorizationId,
          transitionId(intent),
          JSON.stringify(intent),
        );
      });
    },
    finalize(intent) {
      transaction(database, () => {
        integrity.assertUnchanged();
        const stored = readTransitionById(database, transitionId(intent));
        if (stored === undefined || stored.finalized) throw new RepositoryStateError("pending repository transition is missing");
        const result = database.prepare("UPDATE repository_ref_transition SET finalized=1 WHERE transition_id=? AND finalized=0")
          .run(transitionId(intent));
        if (result.changes !== 1) throw new RepositoryStateError("pending repository transition is missing");
      });
    },
    cancel(intent) {
      transaction(database, () => {
        integrity.assertUnchanged();
        const stored = readTransitionById(database, transitionId(intent));
        if (stored === undefined || stored.finalized) throw new RepositoryStateError("pending repository transition is missing");
        const result = database.prepare("DELETE FROM repository_ref_transition WHERE transition_id=? AND finalized=0")
          .run(transitionId(intent));
        if (result.changes !== 1) throw new RepositoryStateError("pending repository transition is missing");
      });
    },
    pending() {
      integrity.assertUnchanged();
      return readPendingTransitions(database).map((entry) => entry.intent);
    },
  };
}
