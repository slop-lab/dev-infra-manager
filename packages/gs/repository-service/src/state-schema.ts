import type { DatabaseSync } from "node:sqlite";

const STATE_VERSION = 2;
const tables = {
  service_metadata: `CREATE TABLE service_metadata(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    current_authority_epoch TEXT NOT NULL
  ) STRICT`,
  authority_epoch: `CREATE TABLE authority_epoch(
    authority_epoch TEXT PRIMARY KEY,
    ref_policy_revision TEXT NOT NULL
  ) STRICT`,
  repository_catalog: `CREATE TABLE repository_catalog(
    namespace_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    incarnation_id TEXT NOT NULL UNIQUE,
    owner_principal_id TEXT NOT NULL,
    initial_policy_digest TEXT NOT NULL,
    initial_policy_json TEXT NOT NULL,
    PRIMARY KEY(namespace_id,repository_id)
  ) STRICT`,
  repository_branch_baseline: `CREATE TABLE repository_branch_baseline(
    namespace_id TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    protected_ref TEXT NOT NULL,
    seed_sequence INTEGER NOT NULL CHECK(seed_sequence=0),
    seed_commit TEXT NOT NULL,
    seed_tree TEXT NOT NULL,
    PRIMARY KEY(namespace_id,repository_id,protected_ref),
    FOREIGN KEY(namespace_id,repository_id) REFERENCES repository_catalog(namespace_id,repository_id)
  ) STRICT`,
  repository_policy_update: `CREATE TABLE repository_policy_update(
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
  ) STRICT`,
  repository_ref_transition: `CREATE TABLE repository_ref_transition(
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
  ) STRICT`,
} as const;
const indexes = {
  repository_ref_transition_branch: "CREATE INDEX repository_ref_transition_branch ON repository_ref_transition(namespace_id,repository_id,protected_ref,finalized,sequence DESC)",
  repository_ref_transition_authorization: "CREATE INDEX repository_ref_transition_authorization ON repository_ref_transition(namespace_id,repository_id,authorization_id,protected_ref,finalized,sequence)",
  repository_ref_transition_pending: "CREATE INDEX repository_ref_transition_pending ON repository_ref_transition(finalized,namespace_id,repository_id,sequence)",
} as const;

export function initializeStateSchema(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const sql of Object.values(tables)) database.exec(sql);
    for (const sql of Object.values(indexes)) database.exec(sql);
    database.prepare("INSERT INTO service_metadata VALUES(1,?)").run("0".repeat(64));
    database.exec(`PRAGMA user_version=${STATE_VERSION}; COMMIT`);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function assertStateSchema(database: DatabaseSync): void {
  const version = database.prepare("PRAGMA user_version").get();
  if (!isRecord(version) || version.user_version !== STATE_VERSION) throw new RepositorySchemaError("repository state version is unsupported");
  const expected = new Map<string, string>();
  for (const [name, sql] of Object.entries(tables)) expected.set(`table:${name}`, canonicalSql(sql));
  for (const [name, sql] of Object.entries(indexes)) expected.set(`index:${name}`, canonicalSql(sql));
  const actual = database.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL").all();
  if (actual.length !== expected.size) throw new RepositorySchemaError("repository state schema objects are unsupported");
  for (const row of actual) {
    if (!isRecord(row) || typeof row.type !== "string" || typeof row.name !== "string" || typeof row.sql !== "string"
      || expected.get(`${row.type}:${row.name}`) !== canonicalSql(row.sql)) {
      throw new RepositorySchemaError("repository state schema definition is unsupported");
    }
  }
}

function canonicalSql(sql: string): string {
  return sql.trim().replace(/;$/, "").replace(/\s+/g, " ").replace(/\s*([(),=])\s*/g, "$1").toLowerCase();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class RepositorySchemaError extends Error {
  readonly name = "RepositorySchemaError";
}
