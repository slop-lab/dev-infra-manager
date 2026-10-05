import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  admission,
  assignment,
  descriptor,
  jsonRecord,
  post,
  startAuthority,
  verifier,
  type AuthorityFixture
} from "./nativeOrdinaryAuthorityFixture.js";

const fixtures: AuthorityFixture[] = [];

afterEach(async () => {
  const completed = fixtures.splice(0);
  await Promise.all(completed.map((fixture) => fixture.close()));
  await Promise.all(completed.map((fixture) => fixture.remove()));
});

describe("native ordinary authority source gates", () => {
  it("rejects authenticated arbitrary Project admission by default without changing SQLite", async () => {
    // Given
    const fixture = await createFixture({ useDefaultSource: true });
    const before = await readFile(fixture.database);

    // When
    const response = await post(
      fixture.endpoint,
      "/v1/operator-admissions",
      "registrar",
      admission("arbitrary-project", "source", "1")
    );

    // Then
    expect(response.status).toBe(503);
    expect(await jsonRecord(response)).toEqual({ error: "native admission source is unavailable" });
    expect(await readFile(fixture.database)).toEqual(before);
    expect(rows(fixture.database)).toEqual({ admissions: 0, attempts: 0 });
  });

  it("rejects authenticated attempt assignment by default without changing SQLite", async () => {
    // Given
    const fixture = await createFixture({ useDefaultSource: true });
    const fabricated = assignment(
      descriptor("arbitrary-project", "source", "generation-1"),
      "a".repeat(64),
      "33333333-3333-4333-8333-333333333333"
    );
    const before = await readFile(fixture.database);

    // When
    const response = await post(fixture.endpoint, "/v1/current-attempt-assignments", "scheduler", fabricated);

    // Then
    expect(response.status).toBe(503);
    expect(await jsonRecord(response)).toEqual({ error: "native admission source is unavailable" });
    expect(await readFile(fixture.database)).toEqual(before);
    expect(rows(fixture.database)).toEqual({ admissions: 0, attempts: 0 });
  });

  it("rejects an authenticated fabricated attempt without changing SQLite", async () => {
    // Given
    const fixture = await createFixture();
    const policy = admission("project-a", "source", "1");
    fixture.source.authorizePolicy(policy);
    const admitted = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy);
    const generation = String((await jsonRecord(admitted)).admissionGeneration);
    const fabricated = assignment(
      descriptor("project-a", "source", generation),
      "a".repeat(64),
      "33333333-3333-4333-8333-333333333333"
    );
    const before = await readFile(fixture.database);

    // When
    const response = await post(fixture.endpoint, "/v1/current-attempt-assignments", "scheduler", fabricated);

    // Then
    expect(response.status).toBe(404);
    expect(await readFile(fixture.database)).toEqual(before);
    expect(rows(fixture.database)).toEqual({ admissions: 1, attempts: 0 });
  });

  it("persists and queries only canonical values returned by the proof source", async () => {
    // Given
    const fixture = await createFixture();
    const requestedPolicy = admission("request-project", "source", "1");
    const canonicalPolicy = admission("project-a", "source", "1");
    fixture.source.authorizePolicy(requestedPolicy, canonicalPolicy);
    const admitted = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", requestedPolicy);
    const admittedBody = await jsonRecord(admitted);
    const generation = String(admittedBody.admissionGeneration);
    const canonicalDescriptor = descriptor("project-a", "source", generation);
    const requestedAttempt = assignment(
      canonicalDescriptor,
      "a".repeat(64),
      "33333333-3333-4333-8333-333333333333"
    );
    const canonicalAttempt = { ...requestedAttempt, attemptId: "10000000-0000-4000-8000-000000000001" };
    fixture.source.authorizeAttempt(requestedAttempt, canonicalAttempt);

    // When
    const recorded = await post(fixture.endpoint, "/v1/current-attempt-assignments", "scheduler", requestedAttempt);
    const client = await verifier(fixture.endpoint);

    // Then
    expect(admittedBody.projectId).toBe("project-a");
    expect(recorded.status).toBe(204);
    await expect(client.assertCurrentAttempt(currentTuple(requestedAttempt), AbortSignal.timeout(1_000))).rejects.toThrow();
    await expect(client.assertCurrentAttempt(currentTuple(canonicalAttempt), AbortSignal.timeout(1_000))).resolves.toBeUndefined();
    expect(storedValues(fixture.database)).toEqual({ projectId: "project-a", attemptId: canonicalAttempt.attemptId });
  });
});

async function createFixture(options: Parameters<typeof startAuthority>[0] = {}): Promise<AuthorityFixture> {
  const fixture = await startAuthority(options);
  fixtures.push(fixture);
  return fixture;
}

function currentTuple(value: ReturnType<typeof assignment>) {
  return {
    reviewId: value.reviewId,
    attemptId: value.attemptId,
    descriptorDigest: value.descriptorDigest,
    admissionGeneration: value.admissionGeneration,
    hostId: value.hostId,
    capacity: value.capacity
  };
}

function rows(file: string): { readonly admissions: number; readonly attempts: number } {
  const database = new DatabaseSync(file, { readOnly: true });
  const result = database.prepare(`
    SELECT (SELECT count(*) FROM native_admissions) admissions,
      (SELECT count(*) FROM native_attempt_assignments) attempts
  `).get();
  database.close();
  if (result === undefined || typeof result.admissions !== "number" || typeof result.attempts !== "number") {
    throw new Error("authority row counts are invalid");
  }
  return { admissions: result.admissions, attempts: result.attempts };
}

function storedValues(file: string): { readonly projectId: string; readonly attemptId: string } {
  const database = new DatabaseSync(file, { readOnly: true });
  const result = database.prepare(`
    SELECT admissions.project_id, attempts.attempt_id
    FROM native_admissions admissions JOIN native_attempt_assignments attempts
  `).get();
  database.close();
  if (result === undefined || typeof result.project_id !== "string" || typeof result.attempt_id !== "string") {
    throw new Error("authority canonical values are missing");
  }
  return { projectId: result.project_id, attemptId: result.attempt_id };
}
