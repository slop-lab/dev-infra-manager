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
  type AuthorityFixture
} from "./nativeOrdinaryAuthorityFixture.js";

const fixtures: AuthorityFixture[] = [];

afterEach(async () => {
  const completed = fixtures.splice(0);
  await Promise.all(completed.map((fixture) => fixture.close()));
  await Promise.all(completed.map((fixture) => fixture.remove()));
});

describe("native ordinary authority source gates", () => {
  it("rejects authenticated arbitrary Project admission without changing SQLite", async () => {
    // Given
    const fixture = await createFixture();
    const before = await readFile(fixture.database);
    expect(fixture.source.requestCount()).toBe(0);

    // When
    const response = await post(
      fixture.endpoint,
      "/v1/operator-admissions",
      "registrar",
      admission("arbitrary-project", "source", "1")
    );

    // Then
    expect(response.status).toBe(404);
    expect(await jsonRecord(response)).toEqual({ error: "not found" });
    expect(fixture.source.requestCount()).toBe(2);
    expect(await readFile(fixture.database)).toEqual(before);
    expect(rows(fixture.database)).toEqual({ admissions: 0, attempts: 0 });
  });

  it("rejects authenticated fabricated attempt without changing SQLite", async () => {
    // Given
    const fixture = await createFixture();
    const fabricated = assignment(
      descriptor("arbitrary-project", "source", "generation-1"),
      "a".repeat(64),
      "33333333-3333-4333-8333-333333333333"
    );
    const before = await readFile(fixture.database);

    // When
    const response = await post(fixture.endpoint, "/v1/current-attempt-assignments", "scheduler", fabricated);

    // Then
    expect(response.status).toBe(404);
    expect(await jsonRecord(response)).toEqual({ error: "not found" });
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

  it("rejects a native attempt tuple that differs from the scheduler assertion", async () => {
    // Given
    const fixture = await createFixture();
    const policy = admission("project-a", "source", "1");
    fixture.source.authorizePolicy(policy);
    const admitted = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy);
    const generation = String((await jsonRecord(admitted)).admissionGeneration);
    const requested = assignment(
      descriptor("project-a", "source", generation),
      "a".repeat(64),
      "33333333-3333-4333-8333-333333333333"
    );
    fixture.source.authorizeAttempt(requested, {
      ...requested,
      attemptId: "44444444-4444-4444-8444-444444444444"
    });
    const before = await readFile(fixture.database);

    // When
    const response = await post(fixture.endpoint, "/v1/current-attempt-assignments", "scheduler", requested);

    // Then
    expect(response.status).toBe(404);
    expect(await readFile(fixture.database)).toEqual(before);
    expect(rows(fixture.database)).toEqual({ admissions: 1, attempts: 0 });
  });

  it.each(["jobs", "revision"] as const)(
    "rejects changed native %s that differ from the registrar assertion",
    async (change) => {
      // Given
      const fixture = await createFixture();
      const requestedPolicy = admission("project-a", "source", "1");
      const canonicalPolicy = change === "jobs"
        ? { ...requestedPolicy, requiredJobs: ["security", "source"] }
        : { ...requestedPolicy, policyRevision: "policy-2" };
      fixture.source.authorizePolicy(requestedPolicy, canonicalPolicy);

      // When
      const response = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", requestedPolicy);

      // Then
      expect(response.status).toBe(404);
      expect(rows(fixture.database)).toEqual({ admissions: 0, attempts: 0 });
    }
  );

  it("rejects a caller-selected subset of globally configured capacities", async () => {
    // Given
    const fixture = await createFixture({
      hosts: [
        { hostId: "host-b", capacities: [{ capacity: "backup", runnerBaseImage, bounds }] },
        { hostId: "host-a", capacities: [{ capacity: "primary", runnerBaseImage, bounds }] }
      ]
    });
    const policy = admission("project-a", "source", "1");
    fixture.source.authorizePolicy(policy);
    const before = await readFile(fixture.database);

    // When
    const response = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy);

    // Then
    expect(response.status).toBe(404);
    expect(await readFile(fixture.database)).toEqual(before);
    expect(rows(fixture.database)).toEqual({ admissions: 0, attempts: 0 });
  });

  it("admits the complete globally configured capacity set in canonical order", async () => {
    // Given
    const fixture = await createFixture({
      hosts: [
        { hostId: "host-b", capacities: [{ capacity: "backup", runnerBaseImage, bounds }] },
        { hostId: "host-a", capacities: [{ capacity: "primary", runnerBaseImage, bounds }] }
      ]
    });
    const policy = {
      ...admission("project-a", "source", "1"),
      eligibleAssignments: [
        { hostId: "host-a", capacity: "primary" },
        { hostId: "host-b", capacity: "backup" }
      ]
    } as const;
    fixture.source.authorizePolicy(policy);

    // When
    const response = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy);

    // Then
    expect(response.status).toBe(200);
    expect(rows(fixture.database)).toEqual({ admissions: 1, attempts: 0 });
  });

  it.each(["redirect", "replay", "wrong-role", "wrong-service", "wrong-scope"] as const)(
    "returns unavailable for %s native proof responses without changing SQLite",
    async (mode) => {
      // Given
      const fixture = await createFixture();
      const policy = admission("project-a", "source", "1");
      fixture.source.authorizePolicy(policy);
      fixture.source.setMode(mode);
      const before = await readFile(fixture.database);

      // When
      const response = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy);

      // Then
      expect(response.status).toBe(503);
      expect(await readFile(fixture.database)).toEqual(before);
      expect(rows(fixture.database)).toEqual({ admissions: 0, attempts: 0 });
    }
  );

  it("rejects the wrong native proof credential without changing SQLite", async () => {
    // Given
    const fixture = await createFixture({
      nativeGitIdentity: {
        username: "wrong-ordinary-identity",
        password: "wrong-identity-secret-0000000000000000"
      }
    });
    const policy = admission("project-a", "source", "1");
    fixture.source.authorizePolicy(policy);
    const before = await readFile(fixture.database);

    // When
    const response = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy);

    // Then
    expect(response.status).toBe(503);
    expect(await readFile(fixture.database)).toEqual(before);
    expect(rows(fixture.database)).toEqual({ admissions: 0, attempts: 0 });
  });

  it("times out an unavailable native proof service without changing SQLite", async () => {
    // Given
    const fixture = await createFixture();
    const policy = admission("project-a", "source", "1");
    fixture.source.authorizePolicy(policy);
    fixture.source.setMode("timeout");
    const before = await readFile(fixture.database);

    // When
    const response = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy);

    // Then
    expect(response.status).toBe(503);
    expect(await readFile(fixture.database)).toEqual(before);
    expect(rows(fixture.database)).toEqual({ admissions: 0, attempts: 0 });
  }, 7_000);
});

const runnerBaseImage = `registry.example/runner@sha256:${"3".repeat(64)}`;
const bounds = {
  cpu: "2",
  memoryBytes: "2147483648",
  pids: "512",
  wallClockSeconds: "900",
  outputBytes: "10485760"
} as const;

async function createFixture(options: Parameters<typeof startAuthority>[0] = {}): Promise<AuthorityFixture> {
  const fixture = await startAuthority(options);
  fixtures.push(fixture);
  return fixture;
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
