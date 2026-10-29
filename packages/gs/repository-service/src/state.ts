import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const STATE_VERSION = 2;
const schemaNames = [
  "authority_epoch",
  "repository_branch_baseline",
  "repository_catalog",
  "repository_policy_update",
  "repository_ref_transition",
  "service_metadata",
] as const;

export async function openStateDatabase(path: string, createState: boolean): Promise<DatabaseSync> {
  const file = createState
    ? await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    : await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const identity = await file.stat({ bigint: true });
    const uid = process.getuid?.();
    if (uid === undefined || !identity.isFile() || identity.nlink !== 1n
      || identity.uid !== BigInt(uid) || (identity.mode & 0o777n) !== 0o600n) {
      throw new RepositoryStateError("repository state must be a caller-owned mode-0600 regular file");
    }
  } finally {
    await file.close();
  }
  const database = new DatabaseSync(path, { defensive: true, timeout: 0 });
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA trusted_schema=OFF");
    if (createState) initializeState(database);
    validateStateSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function initializeAuthorityEpoch(database: DatabaseSync, epoch: string, refPolicyRevision: string): void {
  transaction(database, () => {
    database.prepare("INSERT INTO authority_epoch(authority_epoch,ref_policy_revision) VALUES(?,?)").run(epoch, refPolicyRevision);
    database.prepare("UPDATE service_metadata SET current_authority_epoch=? WHERE singleton=1").run(epoch);
  });
}

export function transaction<Result>(database: DatabaseSync, operation: () => Result): Result {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function initializeState(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE service_metadata(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      current_authority_epoch TEXT NOT NULL
    ) STRICT;
    CREATE TABLE authority_epoch(
      authority_epoch TEXT PRIMARY KEY,
      ref_policy_revision TEXT NOT NULL
    ) STRICT;
    CREATE TABLE repository_catalog(
      namespace_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      incarnation_id TEXT NOT NULL UNIQUE,
      owner_principal_id TEXT NOT NULL,
      initial_policy_digest TEXT NOT NULL,
      initial_policy_json TEXT NOT NULL,
      PRIMARY KEY(namespace_id,repository_id)
    ) STRICT;
    CREATE TABLE repository_branch_baseline(
      namespace_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      protected_ref TEXT NOT NULL,
      seed_sequence INTEGER NOT NULL CHECK(seed_sequence=0),
      seed_commit TEXT NOT NULL,
      seed_tree TEXT NOT NULL,
      PRIMARY KEY(namespace_id,repository_id,protected_ref),
      FOREIGN KEY(namespace_id,repository_id) REFERENCES repository_catalog(namespace_id,repository_id)
    ) STRICT;
    CREATE TABLE repository_policy_update(
      namespace_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>0),
      head_sequence INTEGER NOT NULL CHECK(head_sequence>=0),
      head_commit TEXT NOT NULL,
      previous_policy_digest TEXT NOT NULL,
      policy_digest TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      PRIMARY KEY(namespace_id,repository_id,revision),
      FOREIGN KEY(namespace_id,repository_id) REFERENCES repository_catalog(namespace_id,repository_id)
    ) STRICT;
    CREATE TABLE repository_ref_transition(
      namespace_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence>0),
      protected_ref TEXT NOT NULL,
      authorization_id TEXT NOT NULL,
      transition_id TEXT NOT NULL UNIQUE,
      record_json TEXT NOT NULL,
      finalized INTEGER NOT NULL CHECK(finalized IN(0,1)),
      PRIMARY KEY(namespace_id,repository_id,sequence),
      FOREIGN KEY(namespace_id,repository_id) REFERENCES repository_catalog(namespace_id,repository_id)
    ) STRICT;
    CREATE INDEX repository_ref_transition_branch ON repository_ref_transition(namespace_id,repository_id,protected_ref,finalized,sequence DESC);
    CREATE INDEX repository_ref_transition_authorization ON repository_ref_transition(namespace_id,repository_id,authorization_id,protected_ref,finalized,sequence);
    CREATE INDEX repository_ref_transition_pending ON repository_ref_transition(finalized,namespace_id,repository_id,sequence);
    INSERT INTO service_metadata VALUES(1,'${"0".repeat(64)}');
    PRAGMA user_version=${STATE_VERSION};
    COMMIT;
  `);
}

function validateStateSchema(database: DatabaseSync): void {
  const version = database.prepare("PRAGMA user_version").get();
  if (!isRecord(version) || version.user_version !== STATE_VERSION) throw new RepositoryStateError("repository state version is unsupported");
  const names = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  if (names.length !== schemaNames.length || names.some((row, index) => !isRecord(row) || row.name !== schemaNames[index])) {
    throw new RepositoryStateError("repository state schema is unsupported");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class RepositoryStateError extends Error {
  readonly name = "RepositoryStateError";
}
