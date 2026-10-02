import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";

const ORDINARY_CI_POOL_DATABASE_SCHEMA_VERSION = 1;

export function openOrdinaryCiPoolDatabase(file: string): DatabaseSync {
  const existing = existsSync(file);
  if (existing) assertSupportedSchema(file);
  const database = new DatabaseSync(file);
  try {
    if (!existing) {
      database.exec(`
        CREATE TABLE queued_jobs (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          job_id INTEGER NOT NULL,
          admission_id TEXT NOT NULL,
          UNIQUE(project_id, job_id, admission_id)
        );
        CREATE TABLE completed_jobs (
          project_id TEXT NOT NULL,
          job_id INTEGER NOT NULL,
          completed INTEGER NOT NULL DEFAULT 0,
          completed_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY(project_id, job_id)
        );
        CREATE TABLE claims (
          claim_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          job_id INTEGER NOT NULL,
          admission_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          capacity TEXT NOT NULL,
          request_id TEXT NOT NULL,
          lease_expires_at INTEGER NOT NULL,
          UNIQUE(host_id, capacity),
          UNIQUE(host_id, request_id),
          UNIQUE(project_id, job_id)
        );
        PRAGMA user_version = ${ORDINARY_CI_POOL_DATABASE_SCHEMA_VERSION};
      `);
    }
    database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function assertSupportedSchema(file: string): void {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const version = database.prepare("PRAGMA user_version").get();
    if (!isRecord(version) || version.user_version !== ORDINARY_CI_POOL_DATABASE_SCHEMA_VERSION) {
      throw new UserError(
        `ordinary CI pool database schema version is unsupported; expected ${ORDINARY_CI_POOL_DATABASE_SCHEMA_VERSION}`
      );
    }
  } finally {
    database.close();
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
