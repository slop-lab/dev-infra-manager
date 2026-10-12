import { randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseNativeQemuReviewEvent } from "./nativeQemuReviewEvent.js";
import { parseNativeQemuTerminalEvent } from "./nativeQemuTerminalEvent.js";

const schemaVersion = "3";

export function openNativeQemuSchedulerDatabase(path: string, executionAuthorityJson: string): DatabaseSync {
  assertPrivateDirectory(dirname(path));
  let fresh = false;
  try {
    assertPrivateFile(path);
    for (const suffix of ["-wal", "-shm", "-journal"] as const) assertOptionalPrivateFile(`${path}${suffix}`);
    validateExisting(path, executionAuthorityJson);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    closeSync(descriptor);
    chmodSync(path, 0o600);
    fresh = true;
  }
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys=ON");
    if (fresh) initialize(database, executionAuthorityJson);
    database.exec("PRAGMA journal_mode=WAL");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function initialize(database: DatabaseSync, executionAuthorityJson: string): void {
  database.exec(`BEGIN IMMEDIATE;
    CREATE TABLE native_qemu_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE native_qemu_eligibility (
      project_id TEXT PRIMARY KEY, eligibility_generation TEXT UNIQUE NOT NULL,
      lease_expires_at INTEGER NOT NULL, refreshed_at INTEGER NOT NULL);
    CREATE TABLE native_qemu_events (
      event_id TEXT PRIMARY KEY, admission_generation TEXT NOT NULL, event_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','reserved','active','completed','superseded')), created_at INTEGER NOT NULL);
    CREATE TABLE native_qemu_claims (
      claim_id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, event_id TEXT UNIQUE NOT NULL, host_id TEXT NOT NULL,
      capacity TEXT NOT NULL, admission_generation TEXT NOT NULL, lease_expires_at INTEGER NOT NULL,
      attempt_id TEXT, descriptor_digest TEXT, attempt_json TEXT,
      state TEXT NOT NULL CHECK(state IN ('reserved','active','completed')),
      result_json TEXT, FOREIGN KEY(event_id) REFERENCES native_qemu_events(event_id));
    CREATE TABLE native_qemu_report_outbox (
      claim_id TEXT PRIMARY KEY REFERENCES native_qemu_claims(claim_id), terminal_event_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','delivered')), created_at INTEGER NOT NULL,
      delivered_at INTEGER);
    CREATE UNIQUE INDEX native_qemu_capacity_fence ON native_qemu_claims(host_id, capacity)
      WHERE state IN ('reserved','active');
    PRAGMA user_version=3;`);
  const insert = database.prepare("INSERT INTO native_qemu_metadata (key,value) VALUES (?,?)");
  insert.run("schema_version", schemaVersion);
  insert.run("service_generation_id", randomUUID());
  insert.run("execution_authority_json", executionAuthorityJson);
  database.exec("COMMIT");
}

function validateExisting(path: string, executionAuthorityJson: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (field(integrity, "integrity_check") !== "ok") invalid();
    const version = database.prepare("PRAGMA user_version").get();
    if (numericField(version, "user_version") !== 3) invalid();
    const objects = database.prepare(`SELECT name FROM sqlite_master
      WHERE (type='table' OR type='index') AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((row) => field(row, "name"));
    if (JSON.stringify(objects) !== JSON.stringify(["native_qemu_capacity_fence", "native_qemu_claims",
      "native_qemu_eligibility", "native_qemu_events", "native_qemu_metadata", "native_qemu_report_outbox"])) invalid();
    const metadata = database.prepare("SELECT key,value FROM native_qemu_metadata ORDER BY key").all();
    if (metadata.length !== 3 || field(metadata[0], "key") !== "execution_authority_json"
      || field(metadata[0], "value") !== executionAuthorityJson || field(metadata[1], "key") !== "schema_version"
      || field(metadata[1], "value") !== schemaVersion || field(metadata[2], "key") !== "service_generation_id") invalid();
    uuid(field(metadata[2], "value"));
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) invalid();
    for (const row of database.prepare("SELECT * FROM native_qemu_eligibility").all()) {
      identifier(field(row, "project_id"));
      generation(field(row, "eligibility_generation"));
      numericField(row, "lease_expires_at");
      numericField(row, "refreshed_at");
    }
    for (const row of database.prepare("SELECT * FROM native_qemu_events").all()) {
      const event = parseNativeQemuReviewEvent(JSON.parse(field(row, "event_json")));
      if (field(row, "event_id") !== event.eventId) invalid();
      generation(field(row, "admission_generation"));
      state(field(row, "state"));
      numericField(row, "created_at");
    }
    for (const row of database.prepare("SELECT * FROM native_qemu_claims").all()) {
      uuid(field(row, "claim_id"));
      uuid(field(row, "request_id"));
      if (!/^[0-9a-f]{64}$/.test(field(row, "event_id"))) invalid();
      identifier(field(row, "host_id"));
      identifier(field(row, "capacity"));
      generation(field(row, "admission_generation"));
      numericField(row, "lease_expires_at");
      const claimState = state(field(row, "state"));
      const attemptId = nullableField(row, "attempt_id");
      const descriptorDigest = nullableField(row, "descriptor_digest");
      const attemptJson = nullableField(row, "attempt_json");
      const hasAttempt = attemptId !== undefined && descriptorDigest !== undefined && attemptJson !== undefined;
      const hasNoAttempt = attemptId === undefined && descriptorDigest === undefined && attemptJson === undefined;
      if ((claimState === "reserved" && !hasNoAttempt) || (claimState === "active" && !hasAttempt)
        || (claimState === "completed" && !hasAttempt && !hasNoAttempt)) invalid();
      if (hasAttempt) {
        if (attemptId === undefined || descriptorDigest === undefined || attemptJson === undefined) invalid();
        uuid(attemptId);
        digest(descriptorDigest);
        const attempt = exactRecord(JSON.parse(attemptJson),
          ["attemptId", "descriptorDigest", "descriptor"]);
        if (attempt.attemptId !== attemptId || attempt.descriptorDigest !== descriptorDigest
          || !isRecord(attempt.descriptor)) invalid();
      }
      const result = nullableField(row, "result_json");
      if (result !== undefined) {
        const completion = exactRecord(JSON.parse(result), ["claimId", "cleanupComplete", "eventId", "result", "terminalEvent"]);
        if (completion.claimId !== field(row, "claim_id") || completion.cleanupComplete !== true
          || typeof completion.eventId !== "string"
          || (completion.result !== "success" && completion.result !== "failure" && completion.result !== "cancelled")
          || !isRecord(completion.terminalEvent)) invalid();
        parseNativeQemuTerminalEvent(completion.terminalEvent);
        uuid(completion.eventId);
      }
    }
    for (const row of database.prepare("SELECT * FROM native_qemu_report_outbox").all()) {
      uuid(field(row, "claim_id"));
      parseNativeQemuTerminalEvent(JSON.parse(field(row, "terminal_event_json")));
      const reportState = field(row, "state");
      if (reportState !== "pending" && reportState !== "delivered") invalid();
      numericField(row, "created_at");
      const deliveredAt = nullableNumber(row, "delivered_at");
      if ((reportState === "pending" && deliveredAt !== undefined)
        || (reportState === "delivered" && deliveredAt === undefined)) invalid();
    }
  } catch (error) {
    if (error instanceof NativeQemuSchedulerDatabaseError) throw error;
    throw new NativeQemuSchedulerDatabaseError("native QEMU scheduler database is invalid", { cause: error });
  } finally {
    database.close();
  }
}

function assertPrivateDirectory(path: string): void {
  const metadata = lstatSync(path);
  const owner = process.getuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || owner === undefined || metadata.uid !== owner
    || (metadata.mode & 0o777) !== 0o700) invalid();
}

function assertPrivateFile(path: string): void {
  const metadata = lstatSync(path);
  const owner = process.getuid?.();
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || owner === undefined
    || metadata.uid !== owner || (metadata.mode & 0o777) !== 0o600) invalid();
}

function assertOptionalPrivateFile(path: string): void {
  try { assertPrivateFile(path); }
  catch (error) { if (!isMissing(error)) throw error; }
}

function field(row: unknown, key: string): string {
  const value = isRecord(row) ? row[key] : undefined;
  if (typeof value !== "string") invalid();
  return value;
}
function nullableField(row: unknown, key: string): string | undefined {
  const value = isRecord(row) ? row[key] : undefined;
  if (value === null) return undefined;
  if (typeof value !== "string") invalid();
  return value;
}
function numericField(row: unknown, key: string): number {
  const value = isRecord(row) ? row[key] : undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid();
  return value;
}
function nullableNumber(row: unknown, key: string): number | undefined {
  const value = isRecord(row) ? row[key] : undefined;
  if (value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid();
  return value;
}
function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length
    || fields.some((fieldName) => !Object.hasOwn(value, fieldName))) invalid();
  return value;
}
function identifier(value: string): string { if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) invalid(); return value; }
function generation(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) invalid(); return value; }
function revision(value: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(value)) invalid();
  return value;
}
function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) invalid();
  return value;
}
function digest(value: string): string { if (!/^sha256:[0-9a-f]{64}$/.test(value)) invalid(); return value; }
function state(value: string): "queued" | "reserved" | "active" | "completed" | "superseded" {
  if (value !== "queued" && value !== "reserved" && value !== "active" && value !== "completed"
    && value !== "superseded") invalid();
  return value;
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMissing(error: unknown): boolean { return error instanceof Error && Reflect.get(error, "code") === "ENOENT"; }
function invalid(): never { throw new NativeQemuSchedulerDatabaseError("native QEMU scheduler database is invalid"); }
export class NativeQemuSchedulerDatabaseError extends Error { readonly name = "NativeQemuSchedulerDatabaseError"; }
