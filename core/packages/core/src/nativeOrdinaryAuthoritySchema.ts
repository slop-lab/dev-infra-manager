import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";

const schemaVersion = 3;

const schemaSql = `
  CREATE TABLE service_epochs (
    epoch_id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL CHECK(started_at > 0),
    active INTEGER NOT NULL CHECK(active IN (0,1))
  ) STRICT;
  CREATE UNIQUE INDEX service_epochs_one_active ON service_epochs(active) WHERE active = 1;
  CREATE TABLE native_admissions (
    admission_generation TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    protected_ref TEXT NOT NULL,
    policy_revision TEXT NOT NULL,
    required_review_revision TEXT NOT NULL,
    required_job_set_revision TEXT NOT NULL,
    policy_digest TEXT NOT NULL,
    capacity_config_digest TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL CHECK(expires_at > 0),
    state TEXT NOT NULL CHECK(state IN ('active','expired','revoked','replaced')),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    updated_at INTEGER NOT NULL CHECK(updated_at > 0)
  ) STRICT;
  CREATE UNIQUE INDEX native_admissions_active_project_repository
    ON native_admissions(project_id, repository_id) WHERE state = 'active';
  CREATE TABLE native_attempt_assignments (
    review_id TEXT NOT NULL,
    job_name TEXT NOT NULL,
    claim_id TEXT NOT NULL UNIQUE REFERENCES claims(claim_id) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL UNIQUE,
    descriptor_digest TEXT NOT NULL,
    admission_generation TEXT NOT NULL REFERENCES native_admissions(admission_generation) ON DELETE RESTRICT,
    host_id TEXT NOT NULL,
    capacity TEXT NOT NULL,
    PRIMARY KEY(review_id, job_name)
  ) STRICT;
  CREATE TABLE native_event_replay_fences (
    event_id TEXT PRIMARY KEY,
    event_digest TEXT NOT NULL
  ) STRICT;
  CREATE TABLE review_job_replay_fences (
    review_id TEXT NOT NULL,
    job_name TEXT NOT NULL,
    tuple_digest TEXT NOT NULL,
    PRIMARY KEY(review_id, job_name)
  ) STRICT;
  CREATE TABLE native_event_inbox (
    event_id TEXT PRIMARY KEY REFERENCES native_event_replay_fences(event_id) ON DELETE RESTRICT,
    event_digest TEXT NOT NULL UNIQUE,
    event_json TEXT NOT NULL,
    project_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    protected_ref TEXT NOT NULL,
    review_id TEXT NOT NULL,
    expected_protected_head TEXT NOT NULL,
    candidate_commit TEXT NOT NULL,
    candidate_tree TEXT NOT NULL,
    policy_revision TEXT NOT NULL,
    required_review_revision TEXT NOT NULL,
    required_job_set_revision TEXT NOT NULL,
    job_name TEXT NOT NULL,
    evidence_class TEXT NOT NULL CHECK(evidence_class = 'candidate-controlled'),
    demand_id TEXT UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('accepted','terminal')),
    received_at INTEGER NOT NULL CHECK(received_at > 0),
    terminal_at INTEGER,
    FOREIGN KEY(demand_id) REFERENCES demands(demand_id) ON DELETE RESTRICT
  ) STRICT;
  CREATE TABLE demands (
    demand_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE REFERENCES native_event_inbox(event_id) ON DELETE RESTRICT,
    project_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    protected_ref TEXT NOT NULL,
    review_id TEXT NOT NULL,
    expected_protected_head TEXT NOT NULL,
    candidate_commit TEXT NOT NULL,
    candidate_tree TEXT NOT NULL,
    policy_revision TEXT NOT NULL,
    required_review_revision TEXT NOT NULL,
    required_job_set_revision TEXT NOT NULL,
    job_name TEXT NOT NULL,
    evidence_class TEXT NOT NULL CHECK(evidence_class = 'candidate-controlled'),
    admission_generation TEXT NOT NULL REFERENCES native_admissions(admission_generation) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK(state IN ('queued','preparing','claimed','reported','completed','superseded','cancelled','failed')),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    updated_at INTEGER NOT NULL CHECK(updated_at > 0),
    terminal_at INTEGER
  ) STRICT;
  CREATE UNIQUE INDEX demands_nonterminal_review_job ON demands(review_id, job_name)
    WHERE state IN ('queued','preparing','claimed','reported');
  CREATE INDEX demands_oldest_queued ON demands(created_at, demand_id) WHERE state = 'queued';
  CREATE TABLE claim_receipts (
    claim_id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    capacity TEXT NOT NULL,
    request_id TEXT NOT NULL,
    demand_id TEXT UNIQUE REFERENCES demands(demand_id) ON DELETE RESTRICT,
    admission_generation TEXT REFERENCES native_admissions(admission_generation) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK(state IN ('empty','preparing','active','reported','recovering','released')),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    updated_at INTEGER NOT NULL CHECK(updated_at > 0),
    released_at INTEGER,
    UNIQUE(host_id, capacity, request_id)
  ) STRICT;
  CREATE TABLE claims (
    claim_id TEXT PRIMARY KEY REFERENCES claim_receipts(claim_id) ON DELETE RESTRICT,
    demand_id TEXT NOT NULL UNIQUE REFERENCES demands(demand_id) ON DELETE RESTRICT,
    host_id TEXT NOT NULL,
    capacity TEXT NOT NULL,
    event_id TEXT NOT NULL REFERENCES native_event_inbox(event_id) ON DELETE RESTRICT,
    review_id TEXT NOT NULL,
    job_name TEXT NOT NULL,
    admission_generation TEXT NOT NULL REFERENCES native_admissions(admission_generation) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL UNIQUE,
    descriptor_json TEXT NOT NULL,
    descriptor_digest TEXT NOT NULL,
    issuance_json TEXT NOT NULL,
    lease_expires_at INTEGER NOT NULL CHECK(lease_expires_at > 0),
    renewal_request_id TEXT,
    recovery_request_id TEXT,
    recovery_resource_id TEXT,
    cleanup_acknowledged_at INTEGER,
    native_revocation_json TEXT,
    released_at INTEGER,
    service_epoch_id TEXT NOT NULL REFERENCES service_epochs(epoch_id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK(state IN ('active','reported','recovering','released')),
    CHECK((recovery_request_id IS NULL AND recovery_resource_id IS NULL AND cleanup_acknowledged_at IS NULL)
      OR (recovery_request_id IS NOT NULL AND recovery_resource_id IS NOT NULL AND cleanup_acknowledged_at > 0)),
    CHECK((state = 'released' AND released_at > 0) OR (state <> 'released' AND released_at IS NULL)),
    CHECK(native_revocation_json IS NULL OR state = 'released')
  ) STRICT;
  CREATE TABLE capacity_fences (
    host_id TEXT NOT NULL,
    capacity TEXT NOT NULL,
    claim_id TEXT NOT NULL UNIQUE REFERENCES claims(claim_id) ON DELETE RESTRICT,
    reason TEXT NOT NULL CHECK(reason IN ('lease-lost','generation-rotated','service-restart','foreign-resource')),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    PRIMARY KEY(host_id, capacity)
  ) STRICT;
  CREATE TABLE host_results (
    claim_id TEXT PRIMARY KEY REFERENCES claims(claim_id) ON DELETE RESTRICT,
    host_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    descriptor_digest TEXT NOT NULL,
    terminal_event_json TEXT NOT NULL,
    terminal_event_digest TEXT NOT NULL,
    cleanup_complete INTEGER NOT NULL CHECK(cleanup_complete = 1),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    UNIQUE(host_id, request_id)
  ) STRICT;
  CREATE TABLE report_outbox (
    claim_id TEXT PRIMARY KEY REFERENCES claims(claim_id) ON DELETE RESTRICT,
    terminal_event_json TEXT NOT NULL,
    terminal_event_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','delivering','delivered','denied')),
    attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
    next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at > 0),
    denial_code TEXT,
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    updated_at INTEGER NOT NULL CHECK(updated_at > 0)
  ) STRICT;
  CREATE INDEX report_outbox_due ON report_outbox(next_attempt_at, claim_id)
    WHERE state IN ('pending','delivering');
  CREATE TABLE terminal_details (
    kind TEXT NOT NULL,
    object_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    terminal_state TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    PRIMARY KEY(kind, object_id)
  ) STRICT;
  PRAGMA user_version = ${schemaVersion};
`;

export function openNativeOrdinaryDatabase(file: string): DatabaseSync {
  const existing = existsSync(file);
  if (existing) assertNativeOrdinarySchema(file);
  const database = new DatabaseSync(file);
  try {
    if (!existing) database.exec(schemaSql);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function assertNativeOrdinarySchema(file: string): void {
  const actual = new DatabaseSync(file, { readOnly: true });
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(schemaSql);
    if (pragmaNumber(actual, "user_version") !== schemaVersion || schemaSignature(actual) !== schemaSignature(expected)) {
      throw new UserError("native ordinary database schema manifest is unsupported");
    }
    const integrity = actual.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || field(integrity[0], "integrity_check") !== "ok"
      || actual.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new UserError("native ordinary database integrity check failed");
    }
  } finally {
    actual.close();
    expected.close();
  }
}

function schemaSignature(database: DatabaseSync): string {
  const objects = database.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','index') ORDER BY type, name
  `).all();
  const tableNames = objects
    .filter((row) => field(row, "type") === "table")
    .map((row) => field(row, "name"))
    .filter((name): name is string => typeof name === "string");
  const metadata = tableNames.map((table) => ({
    table,
    columns: database.prepare(`PRAGMA table_info(${quoted(table)})`).all(),
    indexes: database.prepare(`PRAGMA index_list(${quoted(table)})`).all().map((index) => {
      const name = field(index, "name");
      return { index, columns: typeof name === "string" ? database.prepare(`PRAGMA index_info(${quoted(name)})`).all() : [] };
    }),
    foreignKeys: database.prepare(`PRAGMA foreign_key_list(${quoted(table)})`).all()
  }));
  return JSON.stringify({ objects, metadata }, bigintJson);
}

function pragmaNumber(database: DatabaseSync, name: string): number | undefined {
  const row = database.prepare(`PRAGMA ${name}`).get();
  const value = field(row, name);
  return typeof value === "number" ? value : undefined;
}

function field(row: unknown, name: string): unknown {
  return typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
}

function quoted(identifier: string): string {
  return `'${identifier.replaceAll("'", "''")}'`;
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
