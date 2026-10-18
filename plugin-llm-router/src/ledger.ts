import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { object, text, type RouterConfig } from "./config.js";

export interface WorkspaceGrant { workspaceId: string; workspaceName: string; routeId: string }
export interface Usage { inputTokens: number; outputTokens: number; raw: unknown; source: "backend-response" }
export type Outcome = "completed" | "failed" | "cancelled" | "uncertain";
export class AdmissionError extends Error {}
export class RouterLedger {
  readonly database: DatabaseSync;
  constructor(readonly directory: string, private readonly now: () => number = Date.now) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.geteuid?.() || (root.mode & 0o077) !== 0) throw new Error("router state directory must be owned and private");
    const file = join(directory, "router.sqlite3");
    for (const suffix of ["", "-wal", "-shm"]) {
      if (!existsSync(file + suffix)) continue;
      const stat = lstatSync(file + suffix);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.geteuid?.()) throw new Error("router state file is unsafe");
    }
    this.database = new DatabaseSync(file); chmodSync(file, 0o600);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== 1 && (version !== 0 || this.database.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get())) throw new Error("unsupported router state; choose a fresh directory");
    if (version === 0) this.database.exec(`BEGIN IMMEDIATE;
      CREATE TABLE grants(workspace_id TEXT PRIMARY KEY, workspace_name TEXT NOT NULL, route_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL);
      CREATE TABLE requests(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, route_id TEXT NOT NULL, requested_model TEXT NOT NULL,
        observed_model TEXT, policy_revision TEXT NOT NULL, day TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
        outcome TEXT NOT NULL, capture_bytes INTEGER NOT NULL, capture_complete INTEGER NOT NULL DEFAULT 0,
        request_sha256 TEXT, response_sha256 TEXT, input_tokens INTEGER, output_tokens INTEGER, raw_usage TEXT, error_code TEXT);
      CREATE INDEX workspace_requests ON requests(workspace_id,day,started_at);
      CREATE INDEX active_requests ON requests(workspace_id) WHERE outcome='running';
      PRAGMA user_version=1; COMMIT;`);
  }
  recoverInterrupted(): void {
    // Only the exclusively locked service calls recovery, never a concurrent administrative CLI.
    this.database.prepare("UPDATE requests SET outcome='uncertain',finished_at=?,error_code='router-restarted' WHERE outcome='running'").run(this.now());
  }
  close(): void { this.database.close(); }
  issue(workspace: { id: string; name: string }, routeId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.database.prepare(`INSERT INTO grants VALUES(?,?,?,?,1) ON CONFLICT(workspace_id) DO UPDATE SET
      workspace_name=excluded.workspace_name,route_id=excluded.route_id,token_hash=excluded.token_hash,enabled=1`)
      .run(workspace.id, workspace.name, routeId, hash(token));
    return token;
  }
  authenticate(token: string): WorkspaceGrant | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const row = this.database.prepare("SELECT * FROM grants WHERE token_hash=? AND enabled=1").get(hash(token));
    return row === undefined ? undefined : { workspaceId: text(row.workspace_id), workspaceName: text(row.workspace_name), routeId: text(row.route_id) };
  }
  revoke(workspaceId: string): void { this.database.prepare("UPDATE grants SET enabled=0 WHERE workspace_id=?").run(workspaceId); }
  reserve(grant: WorkspaceGrant, model: string, policyRevision: string, requestBytes: number, limits: RouterConfig["limits"]): string {
    return this.transaction(() => {
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const count = Number(this.database.prepare("SELECT COUNT(*) AS n FROM requests WHERE workspace_id=? AND day=?").get(grant.workspaceId, day)?.n);
      const active = Number(this.database.prepare("SELECT COUNT(*) AS n FROM requests WHERE workspace_id=? AND outcome='running'").get(grant.workspaceId)?.n);
      if (count >= limits.requestsPerUtcDay || active >= limits.concurrent) throw new AdmissionError("workspace request allowance or concurrency is exhausted");
      const used = this.captureBytes(grant.workspaceId);
      if (used + requestBytes > limits.captureBytesPerWorkspace) throw new AdmissionError("workspace capture allowance is exhausted");
      const id = randomUUID();
      this.database.prepare(`INSERT INTO requests(id,workspace_id,route_id,requested_model,policy_revision,day,started_at,outcome,capture_bytes)
        VALUES(?,?,?,?,?,?,?,'running',?)`).run(id, grant.workspaceId, grant.routeId, model, policyRevision, day, this.now(), requestBytes);
      return id;
    });
  }
  append(id: string, workspaceId: string, bytes: number, maximum: number): void {
    this.transaction(() => {
      if (this.captureBytes(workspaceId) + bytes > maximum) throw new AdmissionError("workspace capture allowance is exhausted");
      this.database.prepare("UPDATE requests SET capture_bytes=capture_bytes+? WHERE id=? AND outcome='running'").run(bytes, id);
    });
  }
  finish(id: string, result: { outcome: Outcome; captureComplete: boolean; requestHash?: string; responseHash?: string;
    observedModel?: string; usage?: Usage; errorCode?: string }): void {
    this.database.prepare(`UPDATE requests SET outcome=?,finished_at=?,capture_complete=?,request_sha256=?,response_sha256=?,
      observed_model=?,input_tokens=?,output_tokens=?,raw_usage=?,error_code=? WHERE id=? AND outcome='running'`)
      .run(result.outcome, this.now(), Number(result.captureComplete), result.requestHash ?? null, result.responseHash ?? null,
        result.observedModel ?? null, result.usage?.inputTokens ?? null, result.usage?.outputTokens ?? null,
        result.usage === undefined ? null : JSON.stringify(result.usage), result.errorCode ?? null, id);
  }
  usage(workspaceId: string): Record<string, unknown> {
    const aggregate = this.database.prepare(`SELECT COUNT(*) AS requests, SUM(input_tokens) AS knownInputTokens,
      SUM(output_tokens) AS knownOutputTokens, SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) AS unknownUsageRequests,
      SUM(capture_bytes) AS captureBytes FROM requests WHERE workspace_id=?`).get(workspaceId);
    const recent = this.database.prepare(`SELECT id,route_id AS route,requested_model AS requestedModel,observed_model AS observedModel,
      started_at AS startedAt,finished_at AS finishedAt,outcome,capture_complete AS captureComplete,
      input_tokens AS inputTokens,output_tokens AS outputTokens,error_code AS errorCode FROM requests WHERE workspace_id=? ORDER BY started_at DESC,rowid DESC LIMIT 100`).all(workspaceId);
    return { workspaceId, ...object(aggregate), recent, accounting: "local service traffic; provider subscription allowance is not inferred" };
  }
  private captureBytes(workspaceId: string): number {
    return Number(this.database.prepare("SELECT COALESCE(SUM(capture_bytes),0) AS n FROM requests WHERE workspace_id=?").get(workspaceId)?.n);
  }
  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}
export function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
