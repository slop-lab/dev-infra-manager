import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  admission,
  nativeEvent,
  post,
  startAuthority,
  type AuthorityFixture
} from "./nativeOrdinaryAuthorityFixture.js";

const fixtures: AuthorityFixture[] = [];

afterEach(async () => {
  const completed = fixtures.splice(0);
  await Promise.all(completed.map((fixture) => fixture.close()));
  await Promise.all(completed.map((fixture) => fixture.remove()));
});

describe("native ordinary event replay capacity", () => {
  it("returns 429 only for unseen fences while acknowledging a known replay at the 100000-row caps", async () => {
    // Given
    const fixture = await startAuthority();
    fixtures.push(fixture);
    const policy = admission("project-a", "source", "1");
    fixture.source.authorizePolicy(policy);
    expect((await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy)).status).toBe(200);
    const accepted = nativeEvent();
    fixture.source.authorizeEvent(accepted);
    expect((await post(fixture.endpoint, "/v1/native-events", "webhook", accepted)).status).toBe(202);
    fillReplayFences(fixture.database);
    const unseenEvent = { ...nativeEvent("00000000-0000-4000-8000-000000000003"), reviewId: "b".repeat(64) };
    fixture.source.authorizeEvent(unseenEvent);

    // When
    const replay = await post(fixture.endpoint, "/v1/native-events", "webhook", accepted);
    const unseen = await post(fixture.endpoint, "/v1/native-events", "webhook", unseenEvent);

    // Then
    expect(replay.status).toBe(202);
    expect(unseen.status).toBe(429);
    expect(fenceCounts(fixture.database)).toEqual({ events: 100_000, tuples: 100_000, inbox: 1, demands: 1 });
  });
});

function fillReplayFences(file: string): void {
  const database = new DatabaseSync(file);
  try {
    database.exec(`
      WITH RECURSIVE values_to_add(value) AS (
        SELECT 2 UNION ALL SELECT value + 1 FROM values_to_add WHERE value < 100000
      )
      INSERT INTO native_event_replay_fences(event_id, event_digest)
      SELECT 'fixture-event-' || value, 'sha256:' || printf('%064x', value) FROM values_to_add;
      WITH RECURSIVE values_to_add(value) AS (
        SELECT 2 UNION ALL SELECT value + 1 FROM values_to_add WHERE value < 100000
      )
      INSERT INTO review_job_replay_fences(review_id, job_name, tuple_digest)
      SELECT printf('%064x', value), 'source', 'sha256:' || printf('%064x', value) FROM values_to_add;
    `);
  } finally {
    database.close();
  }
}

function fenceCounts(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      events: count(database, "native_event_replay_fences"),
      tuples: count(database, "review_job_replay_fences"),
      inbox: count(database, "native_event_inbox"),
      demands: count(database, "demands")
    };
  } finally {
    database.close();
  }
}

function count(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
  if (typeof row !== "object" || row === null) throw new Error("expected SQLite count row");
  const total = Reflect.get(row, "total");
  if (typeof total !== "number") throw new Error("expected numeric SQLite count");
  return total;
}
