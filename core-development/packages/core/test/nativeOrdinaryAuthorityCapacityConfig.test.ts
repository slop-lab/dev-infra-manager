import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeOrdinaryAuthorityConfig } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityService.js";
import type { NativeAdmissionPolicy, NativeAttemptAssignment, NativeCapacityPolicy } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityModel.js";
import {
  admission,
  assignment,
  descriptor,
  jsonRecord,
  post,
  startAuthority,
  type AuthorityFixture
} from "./nativeOrdinaryAuthorityFixture.js";

const runnerBaseImage = `registry.example/runner@sha256:${"3".repeat(64)}`;
const replacementRunnerBaseImage = `registry.example/runner@sha256:${"9".repeat(64)}`;
const bounds = {
  cpu: "2",
  memoryBytes: "2147483648",
  pids: "512",
  wallClockSeconds: "900",
  outputBytes: "10485760"
} as const;
const tighterBounds = {
  cpu: "1",
  memoryBytes: "1073741824",
  pids: "256",
  wallClockSeconds: "600",
  outputBytes: "5242880"
} as const;
const primary = { hostId: "host-a", capacity: "primary", runnerBaseImage, bounds } as const;
const backup = { hostId: "host-b", capacity: "backup", runnerBaseImage, bounds } as const;

type CapacityChange = {
  readonly name: string; readonly hosts: NativeOrdinaryAuthorityConfig["hosts"];
  readonly eligibleAssignments: readonly { readonly hostId: string; readonly capacity: string }[];
  readonly selected: NativeCapacityPolicy;
};

const changes = [
  {
    name: "removed capacity",
    hosts: [{ hostId: backup.hostId, capacities: [backup] }],
    eligibleAssignments: [{ hostId: backup.hostId, capacity: backup.capacity }],
    selected: backup
  },
  {
    name: "added capacity",
    hosts: [
      { hostId: backup.hostId, capacities: [backup] },
      { hostId: primary.hostId, capacities: [primary] }
    ],
    eligibleAssignments: [
      { hostId: primary.hostId, capacity: primary.capacity },
      { hostId: backup.hostId, capacity: backup.capacity }
    ],
    selected: primary
  },
  {
    name: "changed runner image",
    hosts: [{
      hostId: primary.hostId,
      capacities: [{ ...primary, runnerBaseImage: replacementRunnerBaseImage }]
    }],
    eligibleAssignments: [{ hostId: primary.hostId, capacity: primary.capacity }],
    selected: { ...primary, runnerBaseImage: replacementRunnerBaseImage }
  },
  {
    name: "tighter bounds",
    hosts: [{ hostId: primary.hostId, capacities: [{ ...primary, bounds: tighterBounds }] }],
    eligibleAssignments: [{ hostId: primary.hostId, capacity: primary.capacity }],
    selected: { ...primary, bounds: tighterBounds }
  }
] satisfies readonly CapacityChange[];

const fixtures: AuthorityFixture[] = [];

afterEach(async () => {
  const completed = fixtures.splice(0);
  await Promise.all(completed.map((fixture) => fixture.close()));
  await Promise.all(completed.map((fixture) => fixture.remove()));
});

describe("native ordinary authority capacity configuration", () => {
  it.each(changes)("invalidates G1 after $name and authorizes only a fresh G2 attempt", async (change) => {
    // Given
    const first = await createFixture();
    const policy = admission("project-a", "source", "1");
    const admitted = await register(first, policy);
    const firstGeneration = generation(admitted);
    const firstDescriptor = descriptor("project-a", "source", firstGeneration);
    const firstAttempt = assignment(
      firstDescriptor,
      "a".repeat(64),
      "10000000-0000-4000-8000-000000000001"
    );
    expect((await recordAssignment(first, firstAttempt)).status).toBe(204);
    expect(await admissionStatus(first, firstAttempt)).toBe(200);
    expect(await currentStatus(first, firstAttempt)).toBe(200);
    await first.close();

    // When
    const restarted = await startAuthority({ database: first.database, hosts: change.hosts });
    fixtures.push(restarted);
    const staleAdmissionStatus = await admissionStatus(restarted, firstAttempt);
    const staleAttemptStatus = await currentStatus(restarted, firstAttempt);
    const nextPolicy = { ...policy, eligibleAssignments: change.eligibleAssignments };
    const refreshed = await register(restarted, nextPolicy);
    const secondGeneration = generation(refreshed);
    const secondDescriptor = {
      ...descriptor("project-a", "source", secondGeneration),
      runnerBaseImage: change.selected.runnerBaseImage,
      bounds: change.selected.bounds
    };
    const secondAttempt = {
      ...assignment(
        secondDescriptor,
        firstAttempt.reviewId,
        "20000000-0000-4000-8000-000000000002"
      ),
      hostId: change.selected.hostId,
      capacity: change.selected.capacity
    };
    const recorded = await recordAssignment(restarted, secondAttempt);

    // Then
    expect(staleAdmissionStatus).toBe(404);
    expect(staleAttemptStatus).toBe(404);
    expect(secondGeneration).not.toBe(firstGeneration);
    expect(recorded.status).toBe(204);
    expect(await currentStatus(restarted, firstAttempt)).toBe(404);
    expect(await currentStatus(restarted, secondAttempt)).toBe(200);
    expect(storedRows(first.database)).toEqual({
      admissions: 2,
      attempts: 1,
      admissionGeneration: secondGeneration,
      attemptGeneration: secondGeneration,
      attemptId: secondAttempt.attemptId,
      hostId: change.selected.hostId,
      capacity: change.selected.capacity
    });
  });

  it("reuses G1 after a same-capacity-config restart with reordered hosts", async () => {
    // Given
    const first = await createFixture([
      { hostId: primary.hostId, capacities: [primary] },
      { hostId: backup.hostId, capacities: [backup] }
    ]);
    const policy = {
      ...admission("project-a", "source", "1"),
      eligibleAssignments: [
        { hostId: primary.hostId, capacity: primary.capacity },
        { hostId: backup.hostId, capacity: backup.capacity }
      ]
    };
    const admitted = await register(first, policy);
    const firstGeneration = generation(admitted);
    await first.close();

    // When
    const restarted = await startAuthority({
      database: first.database,
      hosts: [
        { hostId: backup.hostId, capacities: [backup] },
        { hostId: primary.hostId, capacities: [primary] }
      ]
    });
    fixtures.push(restarted);
    const refreshed = await register(restarted, policy);

    // Then
    expect(generation(refreshed)).toBe(firstGeneration);
    expect(storedAdmissionGeneration(first.database)).toBe(firstGeneration);
  });
});

async function createFixture(hosts?: NativeOrdinaryAuthorityConfig["hosts"]): Promise<AuthorityFixture> {
  const fixture = await startAuthority(hosts === undefined ? {} : { hosts });
  fixtures.push(fixture);
  return fixture;
}

async function register(
  fixture: AuthorityFixture,
  policy: NativeAdmissionPolicy
): Promise<Readonly<Record<string, unknown>>> {
  fixture.source.authorizePolicy(policy);
  const response = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy);
  expect(response.status).toBe(200);
  return jsonRecord(response);
}

async function recordAssignment(fixture: AuthorityFixture, value: NativeAttemptAssignment): Promise<Response> {
  fixture.source.authorizeAttempt(value);
  return post(fixture.endpoint, "/v1/current-attempt-assignments", "scheduler", value);
}

function admissionStatus(fixture: AuthorityFixture, value: NativeAttemptAssignment): Promise<number> {
  return post(fixture.endpoint, "/v1/admission-verifications", "query", {
    schemaVersion: 1,
    requestId: "30000000-0000-4000-8000-000000000003",
    descriptor: value.descriptor,
    descriptorDigest: value.descriptorDigest,
    hostId: value.hostId,
    capacity: value.capacity
  }).then((response) => response.status);
}

function currentStatus(fixture: AuthorityFixture, value: NativeAttemptAssignment): Promise<number> {
  return post(fixture.endpoint, "/v1/current-attempt-verifications", "query", {
    schemaVersion: 1,
    requestId: "40000000-0000-4000-8000-000000000004",
    reviewId: value.reviewId,
    attemptId: value.attemptId,
    descriptorDigest: value.descriptorDigest,
    admissionGeneration: value.admissionGeneration,
    hostId: value.hostId,
    capacity: value.capacity
  }).then((response) => response.status);
}

function generation(value: Readonly<Record<string, unknown>>): string {
  const result = value.admissionGeneration;
  if (typeof result !== "string") throw new Error("admission generation is missing");
  return result;
}

function storedRows(file: string): {
  readonly admissions: number; readonly attempts: number;
  readonly admissionGeneration: string; readonly attemptGeneration: string;
  readonly attemptId: string;
  readonly hostId: string;
  readonly capacity: string;
} {
  const database = new DatabaseSync(file, { readOnly: true });
  const row = database.prepare(`
    SELECT
      (SELECT count(*) FROM native_admissions) admissions,
      (SELECT count(*) FROM native_attempt_assignments) attempts,
      admissions.admission_generation,
      attempts.admission_generation attempt_generation,
      attempts.attempt_id,
      attempts.host_id,
      attempts.capacity
    FROM native_admissions admissions JOIN native_attempt_assignments attempts
      ON attempts.admission_generation = admissions.admission_generation
  `).get();
  database.close();
  if (row === undefined || typeof row.admissions !== "number" || typeof row.attempts !== "number"
    || typeof row.admission_generation !== "string" || typeof row.attempt_generation !== "string"
    || typeof row.attempt_id !== "string" || typeof row.host_id !== "string" || typeof row.capacity !== "string") {
    throw new Error("native authority persisted rows are invalid");
  }
  return {
    admissions: row.admissions,
    attempts: row.attempts,
    admissionGeneration: row.admission_generation,
    attemptGeneration: row.attempt_generation,
    attemptId: row.attempt_id,
    hostId: row.host_id,
    capacity: row.capacity
  };
}

function storedAdmissionGeneration(file: string): string {
  const database = new DatabaseSync(file, { readOnly: true });
  const row = database.prepare("SELECT admission_generation FROM native_admissions").get();
  database.close();
  if (row === undefined || typeof row.admission_generation !== "string") {
    throw new Error("native authority persisted admission is invalid");
  }
  return row.admission_generation;
}
