import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assertSqliteSchema, sqliteSchemaManifestSha256 } from "./sqliteSchemaManifest.js";

const schemaVersion = 6;

const schemaSql = `
  CREATE TABLE bundle_activation (
    generation_id TEXT PRIMARY KEY CHECK(length(generation_id) = 64 AND generation_id NOT GLOB '*[^0-9a-f]*'),
    activation_token_sha256 TEXT NOT NULL UNIQUE
      CHECK(length(activation_token_sha256) = 64 AND activation_token_sha256 NOT GLOB '*[^0-9a-f]*')
  ) STRICT;
  CREATE TABLE native_root_admissions (
    admission_generation TEXT PRIMARY KEY,
    binding_digest TEXT NOT NULL,
    ordinary_service_id TEXT NOT NULL,
    control_plane_generation_id TEXT NOT NULL,
    native_service_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    repository_id TEXT NOT NULL CHECK(repository_id = 'root'),
    import_nonce TEXT NOT NULL,
    root_sequence INTEGER NOT NULL CHECK(root_sequence >= 0),
    protected_ref TEXT NOT NULL,
    root_commit TEXT NOT NULL,
    root_tree TEXT NOT NULL,
    policy_digest TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    capacity_config_digest TEXT NOT NULL,
    lease_expires_at INTEGER NOT NULL CHECK(lease_expires_at > 0),
    state TEXT NOT NULL CHECK(state IN ('active','expired','revoked','replaced')),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    refreshed_at INTEGER NOT NULL CHECK(refreshed_at > 0),
    ended_at INTEGER
  ) STRICT;
  CREATE UNIQUE INDEX native_root_admissions_active_project
    ON native_root_admissions(project_id, repository_id) WHERE state = 'active';
  CREATE TABLE native_root_admission_requests (
    request_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL CHECK(operation IN ('register','current','revoke')),
    tuple_digest TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at > 0)
  ) STRICT;
  CREATE TABLE native_root_ci_event_receipts (
    admission_generation TEXT NOT NULL,
    event_id TEXT NOT NULL CHECK(length(event_id) = 64 AND event_id NOT GLOB '*[^0-9a-f]*'),
    event_digest TEXT NOT NULL CHECK(length(event_digest) = 71 AND event_digest GLOB 'sha256:*'
      AND substr(event_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    event_json TEXT NOT NULL CHECK(length(CAST(event_json AS BLOB)) BETWEEN 1 AND 65536),
    ordinary_service_id TEXT NOT NULL,
    control_plane_generation_id TEXT NOT NULL,
    native_service_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    repository_id TEXT NOT NULL CHECK(repository_id = 'root'),
    import_nonce TEXT NOT NULL,
    policy_digest TEXT NOT NULL,
    root_sequence INTEGER NOT NULL CHECK(root_sequence >= 0),
    root_protected_ref TEXT NOT NULL,
    root_commit TEXT NOT NULL,
    root_tree TEXT NOT NULL,
    capacity_config_digest TEXT NOT NULL,
    received_at INTEGER NOT NULL CHECK(received_at > 0),
    PRIMARY KEY (admission_generation, event_id),
    FOREIGN KEY (admission_generation) REFERENCES native_root_admissions(admission_generation) ON DELETE RESTRICT
  ) STRICT;
  CREATE TABLE native_root_ci_demands (
    demand_id TEXT PRIMARY KEY
      CHECK(length(demand_id) = 36 AND substr(demand_id, 15, 1) = '4'
        AND substr(demand_id, 20, 1) IN ('8','9','a','b')),
    admission_generation TEXT NOT NULL,
    event_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    repository_id TEXT NOT NULL CHECK(repository_id = 'root'),
    protected_ref TEXT NOT NULL,
    review_id TEXT NOT NULL CHECK(length(review_id) = 64 AND review_id NOT GLOB '*[^0-9a-f]*'),
    expected_protected_head TEXT NOT NULL,
    candidate_commit TEXT NOT NULL,
    candidate_tree TEXT NOT NULL,
    policy_revision TEXT NOT NULL,
    required_review_revision TEXT NOT NULL,
    required_job_set_revision TEXT NOT NULL,
    execution_kind TEXT NOT NULL CHECK(execution_kind = 'ordinary-sysbox'),
    job_name TEXT NOT NULL,
    evidence_class TEXT NOT NULL CHECK(evidence_class = 'candidate-controlled'),
    capacity_config_digest TEXT NOT NULL,
    root_sequence INTEGER NOT NULL CHECK(root_sequence >= 0),
    root_commit TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','superseded')),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    updated_at INTEGER NOT NULL CHECK(updated_at > 0),
    terminal_at INTEGER,
    UNIQUE (admission_generation, event_id),
    FOREIGN KEY (admission_generation, event_id)
      REFERENCES native_root_ci_event_receipts(admission_generation, event_id) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX native_root_ci_demands_oldest_queued
    ON native_root_ci_demands(created_at, demand_id) WHERE state = 'queued';
  PRAGMA user_version = ${schemaVersion};
`;

export function openNativeRootAdmissionDatabase(file: string): DatabaseSync {
  const existing = existsSync(file);
  if (existing) assertNativeRootAdmissionSchema(file);
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

export function assertNativeRootAdmissionSchema(file: string): string {
  return assertSqliteSchema(file, { schemaSql, schemaVersion });
}

export function nativeRootAdmissionSchemaManifestSha256(): string {
  return sqliteSchemaManifestSha256({ schemaSql, schemaVersion });
}
