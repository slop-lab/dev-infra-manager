import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseReviewEnvelope } from "../../../../core/packages/native-git/src/review-event-schema.js";
import {
  nativeGitReviewFixture,
  readJsonObject,
  reviewPath,
  stringField,
  type ReviewFixture
} from "../../native-git/test/nativeGitReviewHarness.js";
import {
  admission,
  authorityCredentials,
  jsonRecord,
  nativeEvent,
  post,
  startAuthority,
  type AuthorityFixture
} from "./nativeOrdinaryAuthorityFixture.js";

const fixtures: AuthorityFixture[] = [];
const nativeFixtures: ReviewFixture[] = [];

afterEach(async () => {
  const completed = fixtures.splice(0);
  await Promise.all(completed.map((fixture) => fixture.close()));
  await Promise.all(completed.map((fixture) => fixture.remove()));
  await Promise.all(nativeFixtures.splice(0).map((fixture) => fixture.close()));
});

describe("native ordinary event intake", () => {
  it("accepts a current proven event and atomically stores one inbox, demand, and two fences", async () => {
    // Given
    const fixture = await preparedFixture();
    const event = nativeEvent();

    // When
    const response = await post(fixture.endpoint, "/v1/native-events", "webhook", event);

    // Then
    expect(response.status).toBe(202);
    expect(await jsonRecord(response)).toEqual({ schemaVersion: 1, eventId: event.eventId, accepted: true });
    expect(databaseSummary(fixture.database)).toEqual({
      inbox: 1,
      demands: 1,
      eventFences: 1,
      reviewJobFences: 1,
      assignments: 0,
      demandState: "queued",
      eventDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      tupleDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    });
  });

  it("accepts an event proven by the real native Git stored-event endpoint exactly once", async () => {
    // Given
    const native = await nativeGitReviewFixture();
    nativeFixtures.push(native);
    const reviewResponse = await native.request("reviewer-a-user", "POST", reviewPath(), {
      protectedRef: "refs/heads/main",
      proposalRef: native.proposalRef
    });
    expect(reviewResponse.status).toBe(201);
    const reviewId = stringField(await readJsonObject(reviewResponse), "reviewId");
    const envelope = parseReviewEnvelope(JSON.parse(await readFile(
      join(native.repositoryPath, "dim-reviews", "proposals", `${reviewId}.json`),
      "utf8"
    )));
    const event = envelope.events.find((candidate) => candidate.jobName === "source");
    if (event === undefined) throw new Error("expected stored source event");
    const fixture = await startAuthority({ nativeGitHttpClient: nativeHttpClient(native) });
    fixtures.push(fixture);
    const policy = { ...admission("project-a", "source", "1"), requiredJobs: ["security", "source"] } as const;
    expect((await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy)).status).toBe(200);

    // When
    const first = await post(fixture.endpoint, "/v1/native-events", "webhook", event);
    const replay = await post(fixture.endpoint, "/v1/native-events", "webhook", event);

    // Then
    expect([first.status, replay.status]).toEqual([202, 202]);
    expect(databaseCounts(fixture.database)).toEqual({ inbox: 1, demands: 1, eventFences: 1, reviewJobFences: 1 });
  });

  it("keeps exact and new-ID tuple replays idempotent after restart and more than seven days", async () => {
    // Given
    let now = 1_000;
    const fixture = await preparedFixture({ now: () => now });
    const first = nativeEvent();
    expect((await post(fixture.endpoint, "/v1/native-events", "webhook", first)).status).toBe(202);
    await fixture.close();
    now += 8 * 24 * 60 * 60 * 1_000;
    const restarted = await startAuthority({ database: fixture.database, now: () => now });
    fixtures.push(restarted);
    restarted.source.authorizePolicy(admission("project-a", "source", "1"));
    restarted.source.setMode("timeout");

    // When
    const exact = await post(restarted.endpoint, "/v1/native-events", "webhook", first);
    const alias = await post(restarted.endpoint, "/v1/native-events", "webhook", nativeEvent("00000000-0000-4000-8000-000000000002"));

    // Then
    expect(exact.status).toBe(202);
    expect(alias.status).toBe(202);
    expect(databaseCounts(restarted.database)).toEqual({ inbox: 1, demands: 1, eventFences: 2, reviewJobFences: 1 });
  });

  it("conceals unproven changed event-ID and review-job reuse without mutating durable work", async () => {
    // Given
    const fixture = await preparedFixture();
    const accepted = nativeEvent();
    expect((await post(fixture.endpoint, "/v1/native-events", "webhook", accepted)).status).toBe(202);

    // When
    const changedId = await post(fixture.endpoint, "/v1/native-events", "webhook", { ...accepted, candidateTree: "4".repeat(40) });
    const changedTuple = await post(fixture.endpoint, "/v1/native-events", "webhook", {
      ...accepted,
      eventId: "00000000-0000-4000-8000-000000000002",
      candidateTree: "4".repeat(40)
    });

    // Then
    expect(changedId.status).toBe(404);
    expect(changedTuple.status).toBe(404);
    expect(databaseCounts(fixture.database)).toEqual({ inbox: 1, demands: 1, eventFences: 1, reviewJobFences: 1 });
  });

  it("denies unauthenticated, wrong-role, executable, foreign, expired, and stale-policy events before mutation", async () => {
    // Given
    let now = 1_000;
    const fixture = await preparedFixture({ now: () => now });
    const event = nativeEvent();
    const unauthenticated = fetch(`${fixture.endpoint}/v1/native-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event)
    });
    const wrongRole = post(fixture.endpoint, "/v1/native-events", "query", event);
    const executable = post(fixture.endpoint, "/v1/native-events", "webhook", { ...event, argv: ["sh"] });
    const foreign = post(fixture.endpoint, "/v1/native-events", "webhook", { ...event, projectId: "project-b" });

    // When
    now = 301_001;
    const expired = await post(fixture.endpoint, "/v1/native-events", "webhook", event);
    now = 1_000;
    fixture.source.authorizePolicy(admission("project-a", "source", "2"));
    const stale = await post(fixture.endpoint, "/v1/native-events", "webhook", event);

    // Then
    expect((await unauthenticated).status).toBe(401);
    expect((await wrongRole).status).toBe(403);
    expect((await executable).status).toBe(400);
    expect((await foreign).status).toBe(404);
    expect(expired.status).toBe(404);
    expect(stale.status).toBe(404);
    expect(databaseCounts(fixture.database)).toEqual({ inbox: 0, demands: 0, eventFences: 0, reviewJobFences: 0 });
    expect(admissionStates(fixture.database)).toEqual(["expired"]);
  });

  it("supersedes queued old-generation demand on G1 policy rotation while preserving replay acknowledgement", async () => {
    // Given
    const fixture = await preparedFixture();
    const event = nativeEvent();
    expect((await post(fixture.endpoint, "/v1/native-events", "webhook", event)).status).toBe(202);
    const rotated = admission("project-a", "source", "2");
    fixture.source.authorizePolicy(rotated);

    // When
    expect((await post(fixture.endpoint, "/v1/operator-admissions", "registrar", rotated)).status).toBe(200);
    const replay = await post(fixture.endpoint, "/v1/native-events", "webhook", event);

    // Then
    expect(replay.status).toBe(202);
    expect(databaseSummary(fixture.database).demandState).toBe("superseded");
    expect(databaseCounts(fixture.database)).toEqual({ inbox: 1, demands: 1, eventFences: 1, reviewJobFences: 1 });
  });

  it("rejects a native event with a non-exact JSON content type", async () => {
    // Given
    const fixture = await preparedFixture();

    // When
    const response = await fetch(`${fixture.endpoint}/v1/native-events`, {
      method: "POST",
      headers: webhookHeaders("application/json; charset=utf-8"),
      body: JSON.stringify(nativeEvent())
    });

    // Then
    expect(response.status).toBe(415);
    expect(databaseCounts(fixture.database)).toEqual({ inbox: 0, demands: 0, eventFences: 0, reviewJobFences: 0 });
  });

  it("rejects a native event body above 64 KiB before parsing or mutation", async () => {
    // Given
    const fixture = await preparedFixture();

    // When
    const response = await fetch(`${fixture.endpoint}/v1/native-events`, {
      method: "POST",
      headers: webhookHeaders("application/json"),
      body: JSON.stringify({ ...nativeEvent(), executable: "x".repeat(65 * 1024) })
    });

    // Then
    expect(response.status).toBe(413);
    expect(databaseCounts(fixture.database)).toEqual({ inbox: 0, demands: 0, eventFences: 0, reviewJobFences: 0 });
  });

  it("rejects an event when fresh canonical policy no longer equals the live admission", async () => {
    // Given
    const fixture = await preparedFixture();
    fixture.source.authorizeEvent(nativeEvent(), { ...nativeEvent(), candidateTree: "4".repeat(40) });

    // When
    const response = await post(fixture.endpoint, "/v1/native-events", "webhook", nativeEvent());

    // Then
    expect(response.status).toBe(404);
    expect(databaseCounts(fixture.database)).toEqual({ inbox: 0, demands: 0, eventFences: 0, reviewJobFences: 0 });
    expect(admissionStates(fixture.database)).toEqual(["active"]);
  });

  it("rejects a fabricated policy-valid event when native Git has no exact stored event", async () => {
    // Given
    const fixture = await preparedFixture({ authorizeEvent: false });

    // When
    const response = await post(fixture.endpoint, "/v1/native-events", "webhook", nativeEvent());

    // Then
    expect(response.status).toBe(404);
    expect(databaseCounts(fixture.database)).toEqual({ inbox: 0, demands: 0, eventFences: 0, reviewJobFences: 0 });
  });

  it("supersedes queued demand when its admission expires across restart", async () => {
    // Given
    let now = 1_000;
    const fixture = await preparedFixture({ now: () => now, authorizeEvent: true });
    expect((await post(fixture.endpoint, "/v1/native-events", "webhook", nativeEvent())).status).toBe(202);
    await fixture.close();
    now = 301_001;

    // When
    const restarted = await startAuthority({ database: fixture.database, now: () => now });
    fixtures.push(restarted);

    // Then
    expect(databaseSummary(restarted.database).demandState).toBe("superseded");
    expect(admissionStates(restarted.database)).toEqual(["expired"]);
  });
});

async function preparedFixture(options: { readonly now?: () => number; readonly authorizeEvent?: boolean } = {}): Promise<AuthorityFixture> {
  const fixture = await startAuthority(options);
  fixtures.push(fixture);
  const policy = admission("project-a", "source", "1");
  fixture.source.authorizePolicy(policy);
  expect((await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy)).status).toBe(200);
  if (options.authorizeEvent !== false) fixture.source.authorizeEvent(nativeEvent());
  return fixture;
}

function databaseCounts(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      inbox: count(database, "native_event_inbox"),
      demands: count(database, "demands"),
      eventFences: count(database, "native_event_replay_fences"),
      reviewJobFences: count(database, "review_job_replay_fences")
    };
  } finally {
    database.close();
  }
}

function databaseSummary(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const demand = database.prepare("SELECT state FROM demands").get();
    const eventFence = database.prepare("SELECT event_digest FROM native_event_replay_fences").get();
    const tupleFence = database.prepare("SELECT tuple_digest FROM review_job_replay_fences").get();
    return {
      ...databaseCounts(file),
      assignments: count(database, "native_attempt_assignments"),
      demandState: field(demand, "state"),
      eventDigest: field(eventFence, "event_digest"),
      tupleDigest: field(tupleFence, "tuple_digest")
    };
  } finally {
    database.close();
  }
}

function count(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
  const total = field(row, "total");
  if (typeof total !== "number") throw new Error("expected numeric SQLite count");
  return total;
}

function field(row: unknown, name: string): unknown {
  if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error("expected SQLite row");
  return Reflect.get(row, name);
}

function admissionStates(file: string): readonly string[] {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare("SELECT state FROM native_admissions ORDER BY created_at").all().map((row) => {
      const state = field(row, "state");
      if (typeof state !== "string") throw new Error("expected admission state");
      return state;
    });
  } finally {
    database.close();
  }
}

function webhookHeaders(contentType: string): Readonly<Record<string, string>> {
  const credential = authorityCredentials.webhook;
  return {
    Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`,
    "Content-Type": contentType
  };
}

function nativeHttpClient(fixture: ReviewFixture) {
  return {
    async request(input: {
      readonly method: "GET" | "POST";
      readonly path: string;
      readonly body?: string;
    }) {
      const body: unknown = input.body === undefined ? undefined : JSON.parse(input.body);
      const response = await fixture.request("ordinary-identity", input.method, input.path, body);
      return {
        statusCode: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        cacheControl: response.headers.get("cache-control") ?? undefined,
        body: Buffer.from(await response.arrayBuffer())
      };
    }
  };
}
