import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { configuredNativeOrdinaryAuthorityServer } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityService.js";
import { openNativeOrdinaryDatabase } from "../../../../core/packages/core/src/nativeOrdinaryAuthoritySchema.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native ordinary authority schema manifest", () => {
  it("rejects a webhook credential reused by another authority role", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-credential-"));
    roots.push(root);
    const value = config(join(root, "ordinary.sqlite3"));

    // When
    const start = () => configuredNativeOrdinaryAuthorityServer({
      ...value,
      credentials: { ...value.credentials, webhook: value.credentials.query }
    });

    // Then
    expect(start).toThrow(/credentials must be distinct/);
  });

  it("rejects an attempt issuer credential reused from native identity", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-issuer-credential-"));
    roots.push(root);
    const value = config(join(root, "ordinary.sqlite3"));

    // When
    const start = () => configuredNativeOrdinaryAuthorityServer({
      ...value,
      nativeGit: { ...value.nativeGit, attemptIssuer: value.nativeGit.identity }
    });

    // Then
    expect(start).toThrow(/credentials must be distinct/);
  });

  it("rejects a host token reused from a non-host role", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-host-credential-"));
    roots.push(root);
    const value = config(join(root, "ordinary.sqlite3"));

    // When
    const start = () => configuredNativeOrdinaryAuthorityServer({
      ...value,
      hosts: [{ ...value.hosts[0], hostToken: value.credentials.query.password }]
    });

    // Then
    expect(start).toThrow(/credentials must be distinct/);
  });

  it("rejects a native Git service identity other than the fixed Compose service", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-service-identity-"));
    roots.push(root);
    const value = config(join(root, "ordinary.sqlite3"));
    Reflect.set(value.nativeGit, "serviceId", "foreign-native");

    // When
    const start = () => configuredNativeOrdinaryAuthorityServer(value);

    // Then
    expect(start).toThrow(/native Git identity is invalid/);
  });

  it("rejects the prior two-table schema-3 database byte-for-byte before WAL", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-old-schema3-"));
    roots.push(root);
    const file = join(root, "ordinary.sqlite3");
    const database = new DatabaseSync(file);
    database.exec(`
      CREATE TABLE native_admissions (
        project_id TEXT NOT NULL, repository_id TEXT NOT NULL, service_id TEXT NOT NULL,
        admission_generation TEXT NOT NULL UNIQUE, policy_digest TEXT NOT NULL,
        capacity_config_digest TEXT NOT NULL, policy_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, repository_id)
      );
      CREATE TABLE native_attempt_assignments (
        review_id TEXT NOT NULL, job_name TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE,
        descriptor_digest TEXT NOT NULL, admission_generation TEXT NOT NULL, host_id TEXT NOT NULL,
        capacity TEXT NOT NULL, PRIMARY KEY(review_id, job_name)
      );
      PRAGMA user_version = 3;
    `);
    database.close();
    await rm(`${file}-wal`, { force: true });
    await rm(`${file}-shm`, { force: true });
    const before = await readFile(file);

    // When
    const start = () => configuredNativeOrdinaryAuthorityServer(config(file));

    // Then
    expect(start).toThrow(/schema manifest is unsupported/);
    expect(await readFile(file)).toEqual(before);
    await expect(readFile(`${file}-wal`)).rejects.toThrow();
    await expect(readFile(`${file}-shm`)).rejects.toThrow();
  });

  it("rejects the unreleased six-table schema-3 database byte-for-byte before WAL", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-partial-schema3-"));
    roots.push(root);
    const file = join(root, "ordinary.sqlite3");
    openNativeOrdinaryDatabase(file).close();
    const database = new DatabaseSync(file);
    database.exec(`
      DROP TABLE IF EXISTS terminal_details;
      DROP TABLE IF EXISTS report_outbox;
      DROP TABLE IF EXISTS host_results;
      DROP TABLE IF EXISTS capacity_fences;
      DROP TABLE IF EXISTS native_attempt_assignments;
      DROP TABLE IF EXISTS claims;
      DROP TABLE IF EXISTS claim_receipts;
      DROP TABLE IF EXISTS service_epochs;
      PRAGMA journal_mode = DELETE;
    `);
    database.close();
    await rm(`${file}-wal`, { force: true });
    await rm(`${file}-shm`, { force: true });
    const before = await readFile(file);

    // When
    const start = () => configuredNativeOrdinaryAuthorityServer(config(file));

    // Then
    expect(start).toThrow(/schema manifest is unsupported/);
    expect(await readFile(file)).toEqual(before);
    await expect(readFile(`${file}-wal`)).rejects.toThrow();
    await expect(readFile(`${file}-shm`)).rejects.toThrow();
  });
});

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
