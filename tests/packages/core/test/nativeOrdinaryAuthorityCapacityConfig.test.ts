import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeOrdinaryAuthorityConfig } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityService.js";
import { nativeDescriptorDigest } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityProtocol.js";
import { admission, descriptor, jsonRecord, post, startAuthority, type AuthorityFixture } from "./nativeOrdinaryAuthorityFixture.js";

const runnerBaseImage = `registry.example/runner@sha256:${"3".repeat(64)}`;
const jobBaseImage = `registry.example/job@sha256:${"4".repeat(64)}`;
const bounds = {
  cpu: "2",
  memoryBytes: "2147483648",
  pids: "512",
  wallClockSeconds: "900",
  outputBytes: "10485760"
} as const;
const primary = { capacity: "primary", runnerBaseImage, jobBaseImage, bounds } as const;
const backup = { capacity: "backup", runnerBaseImage, jobBaseImage, bounds } as const;
const hostTokens = {
  "host-a": "host-a-token-000000000000000000000000",
  "host-b": "host-b-token-000000000000000000000000"
} as const;
const fixtures: AuthorityFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.close();
    await fixture.remove();
  }));
});

describe("native ordinary authority capacity configuration", () => {
  it("invalidates G1 when the operator capacity digest changes", async () => {
    // Given
    const first = await createFixture([host("host-a", primary)]);
    const policy = admission("project-a", "source", "1");
    const firstGeneration = await register(first, policy);
    await first.close();

    // When
    const restarted = await startAuthority({ database: first.database, hosts: [host("host-b", backup)] });
    fixtures.push(restarted);
    const secondGeneration = await register(restarted, policy);

    // Then
    expect(secondGeneration).not.toBe(firstGeneration);
    expect(admissionStates(first.database)).toEqual(["replaced", "active"]);
  });

  it("reuses G1 when only host declaration order changes", async () => {
    // Given
    const first = await createFixture([host("host-a", primary), host("host-b", backup)]);
    const policy = admission("project-a", "source", "1");
    const firstGeneration = await register(first, policy);
    await first.close();

    // When
    const restarted = await startAuthority({
      database: first.database,
      hosts: [host("host-b", backup), host("host-a", primary)]
    });
    fixtures.push(restarted);

    // Then
    expect(await register(restarted, policy)).toBe(firstGeneration);
  });

  it("invalidates G1 when the operator job base image changes", async () => {
    // Given
    const first = await createFixture([host("host-a", primary)]);
    const policy = admission("project-a", "source", "1");
    const firstGeneration = await register(first, policy);
    const currentDescriptor = {
      ...descriptor(policy.projectId, policy.repositoryId, firstGeneration),
      runnerBaseImage,
      jobImage: jobBaseImage,
      bounds
    };
    const verification = {
      schemaVersion: 1,
      requestId: "00000000-0000-4000-8000-000000000019",
      descriptor: currentDescriptor,
      descriptorDigest: nativeDescriptorDigest(currentDescriptor),
      hostId: "host-a",
      capacity: "primary"
    };
    expect((await post(first.endpoint, "/v1/admission-verifications", "query", verification)).status).toBe(200);
    await first.close();

    // When
    const changed = { ...primary, jobBaseImage: `registry.example/job@sha256:${"5".repeat(64)}` } as const;
    const restarted = await startAuthority({ database: first.database, hosts: [host("host-a", changed)] });
    fixtures.push(restarted);

    // Then
    expect(admissionStates(first.database)).toEqual(["replaced"]);
    expect((await post(restarted.endpoint, "/v1/admission-verifications", "query", verification)).status).toBe(404);
    expect(await register(restarted, policy)).not.toBe(firstGeneration);
  });
});

function host(hostId: keyof typeof hostTokens, capacity: typeof primary | typeof backup) {
  return { hostId, hostToken: hostTokens[hostId], capacities: [capacity] } as const;
}

async function createFixture(hosts: NativeOrdinaryAuthorityConfig["hosts"]): Promise<AuthorityFixture> {
  const fixture = await startAuthority({ hosts });
  fixtures.push(fixture);
  return fixture;
}

async function register(fixture: AuthorityFixture, policy: ReturnType<typeof admission>): Promise<string> {
  fixture.source.authorizePolicy(policy);
  const response = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy);
  expect(response.status).toBe(200);
  const generation = (await jsonRecord(response)).admissionGeneration;
  if (typeof generation !== "string") throw new Error("admission generation is missing");
  return generation;
}

function admissionStates(file: string): readonly string[] {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare("SELECT state FROM native_admissions ORDER BY created_at, rowid").all().map((row) => {
      if (typeof row.state !== "string") throw new Error("admission state is invalid");
      return row.state;
    });
  } finally {
    database.close();
  }
}
