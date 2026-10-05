import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { configuredNativeOrdinaryAuthorityServer } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityService.js";
import {
  admission,
  jsonRecord,
  post,
  startAuthority,
  type AuthorityFixture
} from "./nativeOrdinaryAuthorityFixture.js";

const fixtures: AuthorityFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.close();
    await fixture.remove();
  }));
});

describe("native ordinary authority", () => {
  it("admits a native policy and keeps a revoked generation denied across restart", async () => {
    // Given
    const fixture = await createFixture();
    const policy = admission("project-a", "source", "1");
    fixture.source.authorizePolicy(policy);
    const registered = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy);
    const generation = (await jsonRecord(registered)).admissionGeneration;
    if (typeof generation !== "string") throw new Error("admission generation is missing");
    expect(registered.status).toBe(200);

    // When
    const revoked = await post(fixture.endpoint, "/v1/operator-admission-revocations", "registrar", {
      schemaVersion: 1,
      projectId: "project-a",
      repositoryId: "source",
      admissionGeneration: generation
    });
    await fixture.close();
    const restarted = await startAuthority({ database: fixture.database });
    fixtures.push(restarted);

    // Then
    expect(revoked.status).toBe(204);
    expect(admissionState(restarted.database)).toBe("revoked");
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
    const start = () => configuredNativeOrdinaryAuthorityServer(config(databasePath));

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

function admissionState(file: string): string {
  const database = new DatabaseSync(file, { readOnly: true });
  const row = database.prepare("SELECT state FROM native_admissions").get();
  database.close();
  if (row === undefined || typeof row.state !== "string") throw new Error("admission state is missing");
  return row.state;
}

function config(database: string) {
  return {
    schemaVersion: 3,
    serviceId: "ordinary-main",
    database,
    admissionLeaseMilliseconds: 300_000,
    claimLeaseMilliseconds: 60_000,
    nativeGit: {
      endpoint: "http://native-git:8080",
      serviceId: "native-main",
      identity: { username: "ordinary-identity", password: "identity-secret-00000000000000000000" },
      attemptIssuer: { username: "ordinary-attempts", password: "attempt-secret-000000000000000000000" }
    },
    credentials: {
      webhook: { username: "native-events", password: "webhook-secret-000000000000000000000" },
      registrar: { username: "operator-registrar", password: "registrar-secret-00000000000000000000" },
      query: { username: "native-query", password: "query-secret-0000000000000000000000" }
    },
    hosts: [{
      hostId: "host-a",
      hostToken: "host-a-token-000000000000000000000000",
      capacities: [{
        capacity: "primary",
        runnerBaseImage: `registry.example/runner@sha256:${"3".repeat(64)}`,
        bounds: { cpu: "2", memoryBytes: "1024", pids: "10", wallClockSeconds: "60", outputBytes: "1024" }
      }]
    }]
  } as const;
}
