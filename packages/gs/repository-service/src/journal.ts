import type { DatabaseSync } from "node:sqlite";
import { finalizedProtectedRef, protectedRefIntentMatchesQuery, type JournalPort } from "@slop-lab/gs-repository";
import { RepositoryStateError, transaction } from "./state.js";
import { assertDurableState } from "./state-validation.js";
import { readTransitions, transitionId } from "./transition-store.js";

export function createJournalPort(database: DatabaseSync): JournalPort {
  return {
    findFinalized(change, protectedRef) {
      assertDurableState(database);
      const entry = readTransitions(database).find(({ intent, finalized }) => finalized
        && intent.namespaceId === change.namespaceId && intent.repositoryId === change.repositoryId
        && intent.authorizationId === change.authorizationId && intent.protectedRef === protectedRef);
      return entry === undefined ? undefined : finalizedProtectedRef(entry.intent);
    },
    findFinalizedExact(query) {
      assertDurableState(database);
      const entry = readTransitions(database).find(({ intent, finalized }) => finalized && protectedRefIntentMatchesQuery(intent, query));
      return entry === undefined ? undefined : finalizedProtectedRef(entry.intent);
    },
    appendIntent(intent) {
      transaction(database, () => {
        assertDurableState(database);
        database.prepare("INSERT INTO repository_ref_transition VALUES(?,?,?,?,?,0)").run(
          intent.namespaceId,
          intent.repositoryId,
          intent.sequence,
          transitionId(intent),
          JSON.stringify(intent),
        );
        assertDurableState(database);
      });
    },
    finalize(intent) {
      transaction(database, () => {
        const result = database.prepare("UPDATE repository_ref_transition SET finalized=1 WHERE transition_id=? AND finalized=0")
          .run(transitionId(intent));
        if (result.changes !== 1) throw new RepositoryStateError("pending repository transition is missing");
        assertDurableState(database);
      });
    },
    cancel(intent) {
      transaction(database, () => {
        const result = database.prepare("DELETE FROM repository_ref_transition WHERE transition_id=? AND finalized=0")
          .run(transitionId(intent));
        if (result.changes !== 1) throw new RepositoryStateError("pending repository transition is missing");
        assertDurableState(database);
      });
    },
    pending() {
      assertDurableState(database);
      return readTransitions(database).filter((entry) => !entry.finalized).map((entry) => entry.intent);
    },
  };
}
