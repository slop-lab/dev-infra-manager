import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assertSqliteSchema, sqliteSchemaManifestSha256 } from "./sqliteSchemaManifest.js";

const schemaVersion = 12;

const schemaSql = `
  CREATE TABLE bundle_activation (
    generation_id TEXT PRIMARY KEY CHECK(length(generation_id) = 64 AND generation_id NOT GLOB '*[^0-9a-f]*'),
    activation_token_sha256 TEXT NOT NULL UNIQUE
      CHECK(length(activation_token_sha256) = 64 AND activation_token_sha256 NOT GLOB '*[^0-9a-f]*')
  ) STRICT;
  CREATE TABLE native_root_ci_service_epochs (
    epoch_id TEXT PRIMARY KEY
      CHECK(length(epoch_id) = 36 AND substr(epoch_id, 15, 1) = '4'
        AND substr(epoch_id, 20, 1) IN ('8','9','a','b')),
    generation_id TEXT NOT NULL REFERENCES bundle_activation(generation_id) ON DELETE RESTRICT,
    started_at INTEGER NOT NULL CHECK(started_at > 0),
    active INTEGER NOT NULL CHECK(active IN (0,1))
  ) STRICT;
  CREATE UNIQUE INDEX native_root_ci_service_epochs_one_active
    ON native_root_ci_service_epochs(active) WHERE active = 1;
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
    state TEXT NOT NULL CHECK(state IN ('queued','preparing','active','reported','completed','superseded')),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    updated_at INTEGER NOT NULL CHECK(updated_at > 0),
    terminal_at INTEGER,
    UNIQUE (admission_generation, event_id),
    FOREIGN KEY (admission_generation, event_id)
      REFERENCES native_root_ci_event_receipts(admission_generation, event_id) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX native_root_ci_demands_oldest_queued
    ON native_root_ci_demands(created_at, demand_id) WHERE state = 'queued';
  CREATE TABLE native_root_ci_claims (
    claim_id TEXT PRIMARY KEY
      CHECK(length(claim_id) = 36 AND substr(claim_id, 15, 1) = '4'
        AND substr(claim_id, 20, 1) IN ('8','9','a','b')),
    issuance_request_id TEXT NOT NULL CHECK(issuance_request_id = claim_id),
    request_id TEXT NOT NULL
      CHECK(length(request_id) = 36 AND substr(request_id, 15, 1) = '4'
        AND substr(request_id, 20, 1) IN ('8','9','a','b')),
    demand_id TEXT NOT NULL UNIQUE REFERENCES native_root_ci_demands(demand_id) ON DELETE RESTRICT,
    admission_generation TEXT NOT NULL,
    event_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    capacity TEXT NOT NULL,
    service_epoch_id TEXT NOT NULL REFERENCES native_root_ci_service_epochs(epoch_id) ON DELETE RESTRICT,
    generation_id TEXT NOT NULL CHECK(length(generation_id) = 64 AND generation_id NOT GLOB '*[^0-9a-f]*'),
    capacity_config_digest TEXT NOT NULL
      CHECK(length(capacity_config_digest) = 64 AND capacity_config_digest NOT GLOB '*[^0-9a-f]*'),
    runner_base_image TEXT NOT NULL,
    job_base_image TEXT NOT NULL,
    bounds_json TEXT NOT NULL,
    response_json TEXT NOT NULL CHECK(length(CAST(response_json AS BLOB)) BETWEEN 1 AND 65536),
    state TEXT NOT NULL CHECK(state IN ('preparing','active','reported','recovering','released')),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    updated_at INTEGER NOT NULL CHECK(updated_at > 0),
    UNIQUE(host_id, capacity, request_id),
    FOREIGN KEY (admission_generation, event_id)
      REFERENCES native_root_ci_event_receipts(admission_generation, event_id) ON DELETE RESTRICT
  ) STRICT;
  CREATE UNIQUE INDEX native_root_ci_claims_capacity_fence
    ON native_root_ci_claims(host_id, capacity) WHERE state <> 'released';
  CREATE TABLE native_root_ci_claim_receipts (
    claim_id TEXT PRIMARY KEY REFERENCES native_root_ci_claims(claim_id) ON DELETE RESTRICT,
    activation_request_id TEXT UNIQUE,
    attempt_id TEXT NOT NULL,
    descriptor_digest TEXT NOT NULL
      CHECK(length(descriptor_digest) = 71 AND descriptor_digest GLOB 'sha256:*'
        AND substr(descriptor_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    assignment_json TEXT NOT NULL CHECK(length(CAST(assignment_json AS BLOB)) BETWEEN 1 AND 65536),
    issuance_json TEXT NOT NULL CHECK(length(CAST(issuance_json AS BLOB)) BETWEEN 1 AND 65536),
    response_json TEXT CHECK(response_json IS NULL OR length(CAST(response_json AS BLOB)) BETWEEN 1 AND 65536),
    lease_expires_at INTEGER NOT NULL CHECK(lease_expires_at > 0),
    state TEXT NOT NULL CHECK(state IN ('active','reported','recovering','released')),
    recovery_request_id TEXT UNIQUE,
    revocation_json TEXT CHECK(revocation_json IS NULL OR length(CAST(revocation_json AS BLOB)) BETWEEN 1 AND 65536),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    updated_at INTEGER NOT NULL CHECK(updated_at > 0),
    released_at INTEGER
  ) STRICT;
  CREATE TABLE native_root_ci_host_results (
    claim_id TEXT PRIMARY KEY REFERENCES native_root_ci_claims(claim_id) ON DELETE RESTRICT,
    host_id TEXT NOT NULL,
    request_id TEXT NOT NULL
      CHECK(length(request_id) = 36 AND substr(request_id, 15, 1) = '4'
        AND substr(request_id, 20, 1) IN ('8','9','a','b')),
    generation_id TEXT NOT NULL CHECK(length(generation_id) = 64 AND generation_id NOT GLOB '*[^0-9a-f]*'),
    attempt_id TEXT NOT NULL
      CHECK(length(attempt_id) = 36 AND substr(attempt_id, 15, 1) = '4'
        AND substr(attempt_id, 20, 1) IN ('8','9','a','b')),
    descriptor_digest TEXT NOT NULL
      CHECK(length(descriptor_digest) = 71 AND descriptor_digest GLOB 'sha256:*'
        AND substr(descriptor_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    request_json TEXT NOT NULL CHECK(length(CAST(request_json AS BLOB)) BETWEEN 1 AND 65536),
    terminal_event_json TEXT NOT NULL CHECK(length(CAST(terminal_event_json AS BLOB)) BETWEEN 1 AND 65536),
    terminal_event_digest TEXT NOT NULL
      CHECK(length(terminal_event_digest) = 71 AND terminal_event_digest GLOB 'sha256:*'
        AND substr(terminal_event_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    cleanup_resource_id TEXT NOT NULL CHECK(cleanup_resource_id = claim_id),
    cleanup_complete INTEGER NOT NULL CHECK(cleanup_complete = 1),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    UNIQUE(host_id, request_id)
  ) STRICT;
  CREATE INDEX native_root_ci_host_results_terminal_selector
    ON native_root_ci_host_results(attempt_id, descriptor_digest, host_id);
  CREATE TRIGGER native_root_ci_host_results_no_update
    BEFORE UPDATE ON native_root_ci_host_results BEGIN SELECT RAISE(ABORT, 'host results are immutable'); END;
  CREATE TRIGGER native_root_ci_host_results_no_delete
    BEFORE DELETE ON native_root_ci_host_results BEGIN SELECT RAISE(ABORT, 'host results are immutable'); END;
  CREATE TABLE native_root_ci_report_outbox (
    claim_id TEXT PRIMARY KEY REFERENCES native_root_ci_host_results(claim_id) ON DELETE RESTRICT,
    terminal_event_json TEXT NOT NULL CHECK(length(CAST(terminal_event_json AS BLOB)) BETWEEN 1 AND 65536),
    terminal_event_digest TEXT NOT NULL
      CHECK(length(terminal_event_digest) = 71 AND terminal_event_digest GLOB 'sha256:*'
        AND substr(terminal_event_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    state TEXT NOT NULL CHECK(state IN ('pending','delivered','denied')),
    acknowledgement_json TEXT
      CHECK(acknowledgement_json IS NULL OR length(CAST(acknowledgement_json AS BLOB)) BETWEEN 1 AND 65536),
    acknowledgement_digest TEXT
      CHECK(acknowledgement_digest IS NULL OR (length(acknowledgement_digest) = 71
        AND acknowledgement_digest GLOB 'sha256:*' AND substr(acknowledgement_digest, 8) NOT GLOB '*[^0-9a-f]*')),
    created_at INTEGER NOT NULL CHECK(created_at > 0),
    delivered_at INTEGER,
    CHECK((state IN ('pending','denied') AND acknowledgement_json IS NULL
        AND acknowledgement_digest IS NULL AND delivered_at IS NULL)
      OR (state = 'delivered' AND acknowledgement_json IS NOT NULL
        AND acknowledgement_digest IS NOT NULL AND delivered_at > 0))
  ) STRICT;
  CREATE INDEX native_root_ci_report_outbox_pending
    ON native_root_ci_report_outbox(created_at, claim_id) WHERE state = 'pending';
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
