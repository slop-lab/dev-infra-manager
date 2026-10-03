import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { configuredOrdinaryCiPoolServer } from "../../../../core/packages/core/src/ordinaryCiPoolService.js";

const roots: string[] = [];
const IMAGE = `registry.example/dim/job@sha256:${"a".repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ordinary CI pool database schema", () => {
  it("rejects an unversioned persisted schema without changing its bytes or queued rows", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-schema-"));
    roots.push(root);
    const database = join(root, "pool.sqlite3");
    const legacy = new DatabaseSync(database);
    legacy.exec(`
      CREATE TABLE queued_jobs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        job_id INTEGER NOT NULL,
        UNIQUE(project_id, job_id)
      );
      INSERT INTO queued_jobs(project_id, job_id) VALUES ('project-a', 300);
    `);
    legacy.close();
    const before = await readFile(database);

    // When
    let failure: unknown;
    try {
      configuredOrdinaryCiPoolServer({
        schemaVersion: 2,
        serviceId: "pool-main",
        database,
        jobImage: IMAGE,
        webhookBaseUrl: "http://127.0.0.1:7410",
        registrarToken: "registrar-token",
        admissionLeaseMilliseconds: 60_000,
        hosts: [{ hostId: "host-a", token: "host-token", capacities: ["primary"] }]
      }).close();
    } catch (error) {
      failure = error;
    }

    // Then
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty("message", expect.stringMatching(/database schema version/));
    expect(await readFile(database)).toEqual(before);
    const preserved = new DatabaseSync(database, { readOnly: true });
    expect(preserved.prepare("SELECT project_id, job_id FROM queued_jobs").get()).toEqual({
      project_id: "project-a",
      job_id: 300
    });
    preserved.close();
  });

  it("rejects the obsolete static-enrollment schema without changing database bytes", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-schema-"));
    roots.push(root);
    const database = join(root, "pool.sqlite3");
    const unsupported = new DatabaseSync(database);
    unsupported.exec("PRAGMA user_version = 1");
    unsupported.close();
    const before = await readFile(database);

    // When
    let failure: unknown;
    try {
      configuredOrdinaryCiPoolServer({
        schemaVersion: 2,
        serviceId: "pool-main",
        database,
        jobImage: IMAGE,
        webhookBaseUrl: "http://127.0.0.1:7410",
        registrarToken: "registrar-token",
        admissionLeaseMilliseconds: 60_000,
        hosts: [{ hostId: "host-a", token: "host-token", capacities: ["primary"] }]
      }).close();
    } catch (error) {
      failure = error;
    }

    // Then
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty("message", expect.stringMatching(/database schema version is unsupported/));
    expect(await readFile(database)).toEqual(before);
  });
});
