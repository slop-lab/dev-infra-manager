import { DatabaseSync } from "node:sqlite";
/** Canonical DDL for both owned initialization and exact shared-schema verification. */
export const routerSchemaSql = `
      CREATE TABLE projects(id TEXT PRIMARY KEY,enabled INTEGER NOT NULL,paused INTEGER NOT NULL,revision TEXT NOT NULL,policy TEXT NOT NULL);
      CREATE TABLE principals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,workspace_id TEXT NOT NULL,workspace_name TEXT NOT NULL,route_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,enabled INTEGER NOT NULL);
      CREATE TABLE requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,principal_id TEXT NOT NULL,workspace_id TEXT NOT NULL,route_id TEXT NOT NULL,account_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,requested_model TEXT NOT NULL,observed_model TEXT,policy_revision TEXT NOT NULL,policy_snapshot TEXT NOT NULL,route_snapshot TEXT NOT NULL,
        day TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,outcome TEXT NOT NULL,execution TEXT NOT NULL,delivery TEXT NOT NULL,accounting TEXT NOT NULL,
        occupied INTEGER NOT NULL,token_reservation INTEGER NOT NULL,dispatched INTEGER NOT NULL DEFAULT 0,cancel_requested INTEGER NOT NULL DEFAULT 0,
        capture_state TEXT NOT NULL,capture_bytes INTEGER NOT NULL,capture_complete INTEGER NOT NULL DEFAULT 0,request_sha256 TEXT,response_sha256 TEXT,
        input_tokens INTEGER,output_tokens INTEGER,raw_usage TEXT,error_code TEXT,response_status INTEGER,response_content_type TEXT);
      CREATE INDEX project_requests ON requests(project_id,day,started_at);
      CREATE INDEX active_requests ON requests(project_id) WHERE occupied=1;
      CREATE TABLE audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,actor TEXT NOT NULL,operation TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL);
`;
let expectedSchema: string | undefined;
function fingerprint(database: DatabaseSync): string {
  const rows = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  return JSON.stringify(rows.map((row) => ({ type: row.type, name: row.name, table: row.tbl_name,
    sql: typeof row.sql === "string" ? row.sql.replace(/\s+/g, " ").replace(/\s*([(),=])\s*/g, "$1").trim().toLowerCase() : row.sql })));
}
/** Format markers remain owned by the inference service; schema identity authorizes attachment. */
export function validateSharedRouterSchema(database: DatabaseSync): void {
  if (expectedSchema === undefined) {
    const reference = new DatabaseSync(":memory:");
    try { reference.exec(routerSchemaSql); expectedSchema = fingerprint(reference); }
    finally { reference.close(); }
  }
  if (fingerprint(database) !== expectedSchema) throw new Error("shared router ledger schema does not exactly match the supported operations");
}
