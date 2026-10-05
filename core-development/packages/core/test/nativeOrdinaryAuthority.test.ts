import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { configuredNativeOrdinaryAuthorityServer } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityService.js";
import type { AdmissionVerifier } from "../../../../core/packages/native-git/src/admission-verifier.js";
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

describe("native ordinary authority", () => {
  it("admits two operator Projects and answers the Native Git query client only after durable assignment", async () => {
    // Given
    const fixture = await createFixture();
    const alphaAdmission = await register(fixture, admission("project-a", "source", "1"));
    const betaAdmission = await register(fixture, admission("project-b", "source", "1"));
    const alpha = descriptor("project-a", "source", generation(alphaAdmission));
    const beta = descriptor("project-b", "source", generation(betaAdmission));
    const nativeClient = await verifier(fixture.endpoint);
    const alphaAssignment = assignment(alpha, "a".repeat(64), "10000000-0000-4000-8000-000000000001");

    // When
    await expectAdmitted(nativeClient, alpha);
    await expectAdmitted(nativeClient, beta);
    await expectCurrentDenied(nativeClient, alphaAssignment);
    const denied = await post(fixture.endpoint, "/v1/current-attempt-verifications", "query", {
      schemaVersion: 1,
      requestId: "20000000-0000-4000-8000-000000000002",
      reviewId: alphaAssignment.reviewId,
      attemptId: alphaAssignment.attemptId,
      descriptorDigest: alphaAssignment.descriptorDigest,
      admissionGeneration: alphaAssignment.admissionGeneration,
      hostId: alphaAssignment.hostId,
      capacity: alphaAssignment.capacity
    });
    const recorded = await recordAssignment(fixture, alphaAssignment);
    await expectCurrent(nativeClient, alphaAssignment);
    await fixture.close();
    const restarted = await startAuthority({ database: fixture.database });
    fixtures.push(restarted);
    const restartedClient = await verifier(restarted.endpoint);

    // Then
    expect(recorded.status).toBe(204);
    expect(denied.status).toBe(404);
    expect(await jsonRecord(denied)).toEqual({ error: "not found" });
    await expectCurrent(restartedClient, alphaAssignment);
    expect(JSON.stringify([alphaAdmission, betaAdmission])).not.toMatch(/secret|password|credential|token/i);
  });

  it("denies stale generations, foreign tuples, credential crossover, and old attempts after restart", async () => {
    // Given
    const fixture = await createFixture();
    const firstAdmission = await register(fixture, admission("project-a", "source", "1"));
    const firstDescriptor = descriptor("project-a", "source", generation(firstAdmission));
    const firstAssignment = assignment(firstDescriptor, "a".repeat(64), "10000000-0000-4000-8000-000000000001");
    expect((await recordAssignment(fixture, firstAssignment)).status).toBe(204);
    const rotatedAdmission = await register(fixture, admission("project-a", "source", "2"));
    await fixture.close();
    const restarted = await startAuthority({ database: fixture.database });
    fixtures.push(restarted);
    const nativeClient = await verifier(restarted.endpoint);

    // When
    const staleAdmission = expectAdmitted(nativeClient, firstDescriptor);
    const staleAttempt = expectCurrent(nativeClient, firstAssignment);
    const foreignDescriptor = { ...firstDescriptor, projectId: "project-b" };
    const foreign = expectAdmitted(nativeClient, foreignDescriptor);
    const queryRegisters = post(restarted.endpoint, "/v1/operator-admissions", "query", admission("project-b", "source", "1"));
    const registrarAssigns = post(restarted.endpoint, "/v1/current-attempt-assignments", "registrar", firstAssignment);

    // Then
    expect(generation(rotatedAdmission)).not.toBe(generation(firstAdmission));
    await expect(staleAdmission).rejects.toThrow();
    await expect(staleAttempt).rejects.toThrow();
    await expect(foreign).rejects.toThrow();
    expect((await queryRegisters).status).toBe(404);
    expect((await registrarAssigns).status).toBe(404);
  });

  it("replaces the current attempt for one review job without authorizing the prior attempt", async () => {
    // Given
    const fixture = await createFixture();
    const registered = await register(fixture, admission("project-a", "source", "1"));
    const admittedDescriptor = descriptor("project-a", "source", generation(registered));
    const first = assignment(admittedDescriptor, "a".repeat(64), "10000000-0000-4000-8000-000000000001");
    const replacement = assignment(admittedDescriptor, first.reviewId, "20000000-0000-4000-8000-000000000002");
    expect((await recordAssignment(fixture, first)).status).toBe(204);
    const nativeClient = await verifier(fixture.endpoint);

    // When
    const recorded = await recordAssignment(fixture, replacement);

    // Then
    expect(recorded.status).toBe(204);
    await expect(expectCurrent(nativeClient, first)).rejects.toThrow();
    await expectCurrent(nativeClient, replacement);
  });

  it("revokes the exact active generation and keeps it denied across restart", async () => {
    // Given
    const fixture = await createFixture();
    const registered = await register(fixture, admission("project-a", "source", "1"));
    const admittedDescriptor = descriptor("project-a", "source", generation(registered));
    const nativeClient = await verifier(fixture.endpoint);

    // When
    const revoked = await post(fixture.endpoint, "/v1/operator-admission-revocations", "registrar", {
      schemaVersion: 1,
      projectId: "project-a",
      repositoryId: "source",
      admissionGeneration: generation(registered)
    });
    await expect(expectAdmitted(nativeClient, admittedDescriptor)).rejects.toThrow();
    await fixture.close();
    const restarted = await startAuthority({ database: fixture.database });
    fixtures.push(restarted);
    const restartedClient = await verifier(restarted.endpoint);

    // Then
    expect(revoked.status).toBe(204);
    await expect(expectAdmitted(restartedClient, admittedDescriptor)).rejects.toThrow();
  });

  it("denies an expired admission and its assigned attempt", async () => {
    // Given
    let now = 1_000;
    const fixture = await startAuthority({ now: () => now });
    fixtures.push(fixture);
    const registered = await register(fixture, admission("project-a", "source", "1"));
    const admittedDescriptor = descriptor("project-a", "source", generation(registered));
    const currentAssignment = assignment(admittedDescriptor, "a".repeat(64), "10000000-0000-4000-8000-000000000001");
    expect((await recordAssignment(fixture, currentAssignment)).status).toBe(204);
    const nativeClient = await verifier(fixture.endpoint);

    // When
    now = 301_001;

    // Then
    await expect(expectAdmitted(nativeClient, admittedDescriptor)).rejects.toThrow();
    await expect(expectCurrent(nativeClient, currentAssignment)).rejects.toThrow();
  });

  it("rejects a predecessor schema-2 database without changing its bytes", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-schema-"));
    const databasePath = join(root, "ordinary.sqlite3");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE predecessor(value TEXT); INSERT INTO predecessor VALUES ('keep'); PRAGMA user_version = 2;");
    database.close();
    const before = await readFile(databasePath);

    // When
    const start = () => configuredNativeOrdinaryAuthorityServer({
      schemaVersion: 3,
      serviceId: "ordinary-main",
      database: databasePath,
      admissionLeaseMilliseconds: 300_000,
      nativeGit: {
        endpoint: "http://native-git:8080",
        serviceId: "native-main",
        identity: { username: "ordinary-identity", password: "identity-secret-00000000000000000000" },
        attemptIssuer: { username: "ordinary-attempts", password: "attempt-secret-000000000000000000000" }
      },
      credentials: {
        webhook: { username: "native-events", password: "webhook-secret-000000000000000000000" },
        registrar: { username: "operator-registrar", password: "registrar-secret-00000000000000000000" },
        query: { username: "native-query", password: "query-secret-0000000000000000000000" },
        scheduler: { username: "ordinary-scheduler", password: "scheduler-secret-0000000000000000" }
      },
      hosts: [{
        hostId: "host-a",
        capacities: [{
          capacity: "primary",
          runnerBaseImage: `registry.example/runner@sha256:${"3".repeat(64)}`,
          bounds: { cpu: "2", memoryBytes: "1024", pids: "10", wallClockSeconds: "60", outputBytes: "1024" }
        }]
      }]
    });

    // Then
    expect(start).toThrow(/schema manifest is unsupported/);
    expect(await readFile(databasePath)).toEqual(before);
    await rm(root, { recursive: true, force: true });
  });
});

async function createFixture(): Promise<AuthorityFixture> {
  const fixture = await startAuthority();
  fixtures.push(fixture);
  return fixture;
}

async function register(fixture: AuthorityFixture, body: ReturnType<typeof admission>): Promise<Readonly<Record<string, unknown>>> {
  fixture.source.authorizePolicy(body);
  const response = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", body);
  expect(response.status).toBe(200);
  return jsonRecord(response);
}

async function recordAssignment(fixture: AuthorityFixture, body: ReturnType<typeof assignment>): Promise<Response> {
  fixture.source.authorizeAttempt(body);
  return post(fixture.endpoint, "/v1/current-attempt-assignments", "scheduler", body);
}

function generation(value: Readonly<Record<string, unknown>>): string {
  const result = value.admissionGeneration;
  if (typeof result !== "string") throw new Error("admission generation is missing");
  return result;
}

async function expectAdmitted(client: AdmissionVerifier, value: ReturnType<typeof descriptor>): Promise<void> {
  const request = assignment(value, "a".repeat(64), "10000000-0000-4000-8000-000000000001");
  await client.assertAdmitted({
    descriptor: value,
    descriptorDigest: request.descriptorDigest,
    hostId: request.hostId,
    capacity: request.capacity
  }, AbortSignal.timeout(1_000));
}

async function expectCurrent(client: AdmissionVerifier, value: ReturnType<typeof assignment>): Promise<void> {
  await client.assertCurrentAttempt({
    reviewId: value.reviewId,
    attemptId: value.attemptId,
    descriptorDigest: value.descriptorDigest,
    admissionGeneration: value.admissionGeneration,
    hostId: value.hostId,
    capacity: value.capacity
  }, AbortSignal.timeout(1_000));
}

async function expectCurrentDenied(client: AdmissionVerifier, value: ReturnType<typeof assignment>): Promise<void> {
  await expect(expectCurrent(client, value)).rejects.toThrow();
}
