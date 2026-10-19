import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { object, text, identifier, parsePolicy, parseLimits, type ProjectPolicy, type RouterLimits } from "./config.js";

export interface WorkspaceGrant { workspaceId: string; workspaceName: string; routeId: string; projectId: string; principalId: string; credentialHash: string }
export interface Usage { inputTokens: number; outputTokens: number; raw: unknown; source: "backend-response" | "operator-resolution" }
export type Outcome = "completed" | "failed" | "cancelled" | "uncertain";
export class AdmissionError extends Error { constructor(message: string, readonly category = "local_quota_exhausted") { super(message); } }
export interface Project { id: string; enabled: boolean; paused: boolean; revision: string; policy: ProjectPolicy }
export class RouterLedger {
  readonly database: DatabaseSync;
  constructor(readonly directory: string, private readonly now: () => number = Date.now) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.geteuid?.() || (root.mode & 0o077) !== 0) throw new Error("router state directory must be owned and private");
    const file = join(directory, "router.sqlite3");
    for (const suffix of ["", "-wal", "-shm"]) { if (!existsSync(file + suffix)) continue; const stat = lstatSync(file + suffix);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.geteuid?.()) throw new Error("router state file is unsafe"); }
    this.database = new DatabaseSync(file); chmodSync(file, 0o600);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== 3 && (version !== 0 || this.database.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get())) { this.database.close(); throw new Error("unsupported router state; choose a fresh directory"); }
    if (version === 0) this.database.exec(`BEGIN IMMEDIATE;
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
      PRAGMA user_version=3; COMMIT;`);
  }
  close(): void { this.database.close(); }
  audit(actor: string, operation: string, target: string, detail: unknown = {}): void {
    this.database.prepare("INSERT INTO audit(at,actor,operation,target,detail) VALUES(?,?,?,?,?)").run(this.now(), actor, operation, target, JSON.stringify(detail));
  }
  createProject(id: string, policy: ProjectPolicy): void {
    identifier(id); const parsed = parsePolicy(policy), revision = hash(JSON.stringify(parsed));
    this.transaction(() => { this.database.prepare("INSERT INTO projects VALUES(?,1,0,?,?)").run(id, revision, JSON.stringify(parsed)); this.audit("operator", "project.create", id, { revision }); });
  }
  project(id: string): Project {
    const row = this.database.prepare("SELECT * FROM projects WHERE id=?").get(id); if (!row) throw new Error("project was not found");
    const policy: unknown = JSON.parse(text(row.policy)); return { id: text(row.id), enabled: row.enabled === 1, paused: row.paused === 1, revision: text(row.revision), policy: parsePolicy(policy) };
  }
  projects(): Project[] { return this.database.prepare("SELECT id FROM projects ORDER BY id").all().map((row) => this.project(text(row.id))); }
  updatePolicy(id: string, policy: ProjectPolicy): void {
    const parsed = parsePolicy(policy), revision = hash(JSON.stringify(parsed)); this.project(id);
    this.transaction(() => { this.database.prepare("UPDATE projects SET revision=?,policy=? WHERE id=?").run(revision, JSON.stringify(parsed), id); this.audit("operator", "project.policy", id, { revision }); });
  }
  setProject(id: string, action: "pause" | "resume" | "disable" | "enable"): void {
    this.project(id); this.transaction(() => {
      this.database.prepare(action === "pause" || action === "resume" ? "UPDATE projects SET paused=? WHERE id=?" : "UPDATE projects SET enabled=? WHERE id=?").run(Number(action === "pause" || action === "enable"), id);
      if (action === "disable") this.database.prepare("UPDATE requests SET cancel_requested=1 WHERE project_id=? AND outcome='running'").run(id);
      this.audit("operator", `project.${action}`, id);
    });
  }
  issue(workspace: { id: string; name: string }, routeId: string, projectId: string, principalId = workspace.id): string {
    const project = this.project(projectId); identifier(principalId);
    if (!project.enabled || !project.policy.allowedRoutes.includes(routeId)) throw new Error("project does not allow this route");
    const old = this.database.prepare("SELECT project_id FROM principals WHERE id=?").get(principalId);
    if (old && old.project_id !== projectId) throw new Error("principal belongs to a different project; create another principal ID");
    const token = randomBytes(32).toString("base64url");
    this.transaction(() => {
      this.database.prepare(`INSERT INTO principals VALUES(?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,
        workspace_name=excluded.workspace_name,route_id=excluded.route_id,token_hash=excluded.token_hash,enabled=1`).run(principalId, projectId, workspace.id, workspace.name, routeId, hash(token));
      this.audit("operator", old ? "principal.rotate" : "principal.issue", principalId, { projectId, workspaceId: workspace.id, routeId });
    }); return token;
  }
  authenticate(token: string): WorkspaceGrant | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const row = this.database.prepare("SELECT * FROM principals WHERE token_hash=? AND enabled=1").get(hash(token));
    if (!row) return undefined;
    const project = this.project(text(row.project_id)); if (!project.enabled) return undefined;
    return { workspaceId: text(row.workspace_id), workspaceName: text(row.workspace_name), routeId: text(row.route_id), projectId: project.id, principalId: text(row.id), credentialHash: text(row.token_hash) };
  }
  revoke(principalId: string): void { this.transaction(() => { this.database.prepare("UPDATE principals SET enabled=0 WHERE id=?").run(principalId); this.audit("operator", "principal.revoke", principalId); }); }
  recoverInterrupted(): void {
    this.transaction(() => {
      this.database.prepare(`UPDATE requests SET outcome=CASE WHEN dispatched=1 THEN 'uncertain' ELSE 'failed' END,input_tokens=CASE WHEN dispatched=1 THEN input_tokens ELSE 0 END,output_tokens=CASE WHEN dispatched=1 THEN output_tokens ELSE 0 END,execution=CASE WHEN dispatched=1 THEN 'outcome_unknown' ELSE 'not_dispatched' END,
        accounting=CASE WHEN dispatched=1 THEN 'reconciliation_required' ELSE 'settled' END,occupied=dispatched,
        token_reservation=CASE WHEN dispatched=1 THEN token_reservation ELSE 0 END,finished_at=?,capture_state=CASE WHEN capture_state='pending' THEN 'partial' ELSE capture_state END,
        error_code='router-restarted' WHERE outcome='running'`).run(this.now());
      this.audit("service", "recovery", "requests", { replayed: false });
    });
  }
  reserve(grant: WorkspaceGrant, model: string, policyRevision: string, requestBytes: number, global: RouterLimits, route: { accountId: string; [key: string]: unknown }) {
    return this.transaction(() => {
      const project = this.project(grant.projectId);
      const policy: ProjectPolicy = { ...project.policy, limits: parseLimits(Object.fromEntries(Object.entries(project.policy.limits).map(([key, value]) => [key, Math.min(value, global[key as keyof RouterLimits])]))) };
      const day = new Date(this.now()).toISOString().slice(0, 10);
      if (!project.enabled || project.paused) throw new AdmissionError("project admissions are paused or disabled", "admissions_paused");
      if (!policy.allowedRoutes.includes(grant.routeId) || !this.database.prepare("SELECT 1 FROM principals WHERE id=? AND token_hash=? AND project_id=? AND workspace_id=? AND route_id=? AND enabled=1").get(grant.principalId, grant.credentialHash, grant.projectId, grant.workspaceId, grant.routeId)) throw new AdmissionError("principal or route is revoked", "authorization_failed");
      for (const [scope, limits] of [["service", global], ["project", policy.limits]] as const) {
        const where = scope === "project" ? "project_id=? AND " : "", parameters = scope === "project" ? [project.id] : [];
        const count = Number(this.database.prepare(`SELECT COUNT(*) AS n FROM requests WHERE ${where}day=?`).get(...parameters, day)?.n);
        const active = Number(this.database.prepare(`SELECT COUNT(*) AS n FROM requests WHERE ${where}occupied=1`).get(...parameters)?.n);
        if (count >= limits.requestsPerUtcDay) throw new AdmissionError(`${scope} UTC-day request allowance is exhausted`);
        if (active >= limits.concurrent) throw new AdmissionError(`${scope} concurrency is occupied (including unresolved dispatches)`, "local_capacity_exhausted");
      }
      const reservation = policy.tokenMode === "estimate" ? policy.estimatedTokensPerRequest ?? 0 : 0;
      if (policy.tokenMode === "estimate") {
        const uncovered = Number(this.database.prepare("SELECT COUNT(*) AS n FROM requests WHERE project_id=? AND day=? AND dispatched=1 AND input_tokens IS NULL AND token_reservation=0").get(project.id, day)?.n);
        if (uncovered) throw new AdmissionError("prior unbounded usage needs reconciliation before estimated admission");
        const charge = Number(this.database.prepare("SELECT COALESCE(SUM(CASE WHEN input_tokens IS NULL THEN token_reservation ELSE input_tokens+output_tokens END),0) AS n FROM requests WHERE project_id=? AND day=?").get(project.id, day)?.n);
        if (charge + reservation > (policy.tokensPerUtcDay ?? 0)) throw new AdmissionError("project estimated token allowance is exhausted; unknown usage reservations remain charged");
      }
      if (requestBytes > policy.limits.requestBytes) throw new AdmissionError("request body exceeds the current project policy", "payload_too_large");
      const bytes = policy.captureMode === "metadata" ? 0 : requestBytes;
      if (this.captureBytes(project.id) + bytes > policy.limits.captureBytesPerProject && policy.captureMode === "required") throw new AdmissionError("project required capture allowance is exhausted", "recording_failed");
      const id = randomUUID(), snapshot = JSON.stringify(policy);
      this.database.prepare(`INSERT INTO requests(id,project_id,principal_id,workspace_id,route_id,account_id,attempt_id,requested_model,policy_revision,policy_snapshot,route_snapshot,
        day,started_at,outcome,execution,delivery,accounting,occupied,token_reservation,capture_state,capture_bytes)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'running','pending','not_started','reserved',1,?,?,?)`).run(id, project.id, grant.principalId, grant.workspaceId, grant.routeId, route.accountId, randomUUID(), model,
          hash(policyRevision + project.revision), snapshot, JSON.stringify(route), day, this.now(), reservation, policy.captureMode === "metadata" ? "disabled_by_policy" : "pending", bytes);
      return { id, policy, policyRevision: hash(policyRevision + project.revision) };
    });
  }
  dispatch(id: string): void {
    const result = this.database.prepare("UPDATE requests SET dispatched=1,execution='dispatched' WHERE id=? AND outcome='running' AND cancel_requested=0").run(id);
    if (!result.changes) throw new AdmissionError("request was cancelled before dispatch", "cancellation_requested");
  }
  captureInput(id: string, digest: string): void { this.database.prepare("UPDATE requests SET request_sha256=? WHERE id=?").run(digest, id); }
  captureFailure(id: string, storedBytes: number): void { this.database.prepare("UPDATE requests SET capture_state='failed',capture_complete=0,capture_bytes=? WHERE id=?").run(storedBytes, id); }
  response(id: string, status: number, contentType: string): void { this.database.prepare("UPDATE requests SET response_status=?,response_content_type=? WHERE id=?").run(status, contentType, id); }
  append(id: string, projectId: string, bytes: number, maximum: number): void {
    this.transaction(() => {
      if (this.captureBytes(projectId) + bytes > maximum) throw new AdmissionError("project capture allowance is exhausted", "recording_failed");
      this.database.prepare("UPDATE requests SET capture_bytes=capture_bytes+?,execution='streaming' WHERE id=? AND outcome='running'").run(bytes, id);
    });
  }
  finish(id: string, result: { outcome: Outcome; captureComplete: boolean; requestHash?: string; responseHash?: string; observedModel?: string; usage?: Usage; errorCode?: string; delivery?: string; executionFinished?: boolean; rawUsage?: unknown }): void {
    const row = this.request(id), dispatched = row.dispatched === 1;
    const finished = result.executionFinished === true || result.outcome === "completed" || result.errorCode === "upstream-rejected";
    const uncertain = dispatched && !finished;
    const unknown = dispatched && result.usage === undefined;
    const capture = row.capture_state === "disabled_by_policy" ? "disabled_by_policy" : result.captureComplete ? "complete" : row.capture_state === "failed" ? "failed" : "partial";
    this.database.prepare(`UPDATE requests SET outcome=?,finished_at=?,execution=?,delivery=?,accounting=?,occupied=?,capture_state=?,capture_complete=?,request_sha256=?,response_sha256=?,
      observed_model=?,input_tokens=?,output_tokens=?,raw_usage=?,error_code=?,token_reservation=CASE WHEN ? THEN token_reservation ELSE 0 END WHERE id=? AND outcome='running'`)
      .run(result.outcome, this.now(), uncertain ? "outcome_unknown" : dispatched ? result.outcome : "not_dispatched", result.delivery ?? (result.outcome === "completed" ? "complete" : "partial"),
        unknown ? "reconciliation_required" : "settled", Number(uncertain), capture, Number(capture === "complete"), result.requestHash ?? null, result.responseHash ?? null, result.observedModel ?? null,
        result.usage?.inputTokens ?? (dispatched ? null : 0), result.usage?.outputTokens ?? (dispatched ? null : 0), result.usage === undefined ? result.rawUsage === undefined ? null : JSON.stringify({ raw: result.rawUsage, source: "backend-response", normalized: null, observedAt: this.now(), completeness: "unverified usage fields" }) : JSON.stringify({ ...result.usage, observedAt: this.now(), completeness: "backend request-level observation" }), result.errorCode ?? null, Number(unknown), id);
  }
  request(id: string, projectId?: string): Record<string, unknown> {
    const row = this.database.prepare("SELECT * FROM requests WHERE id=?" + (projectId === undefined ? "" : " AND project_id=?")).get(...(projectId === undefined ? [id] : [id, projectId]));
    if (!row) throw new Error("request was not found"); return object(row);
  }
  cancel(id: string, actor = "operator"): void { this.transaction(() => { this.request(id); this.database.prepare("UPDATE requests SET cancel_requested=1 WHERE id=? AND outcome='running'").run(id); this.audit(actor, "request.cancel", id, { terminationConfirmed: false }); }); }
  cancelled(id: string): boolean { return this.database.prepare("SELECT cancel_requested FROM requests WHERE id=?").get(id)?.cancel_requested === 1; }
  resolve(id: string, usage?: Usage): void {
    this.transaction(() => {
      const row = this.request(id); if (row.outcome === "running") throw new Error("cancel active work first; resolve only an unfinished/uncertain observation");
      this.database.prepare(`UPDATE requests SET occupied=0,execution=CASE WHEN execution='outcome_unknown' THEN 'operator_resolved' ELSE execution END,
        accounting=?,token_reservation=CASE WHEN ? THEN 0 ELSE token_reservation END,input_tokens=COALESCE(?,input_tokens),output_tokens=COALESCE(?,output_tokens),raw_usage=COALESCE(?,raw_usage) WHERE id=?`)
        .run(usage ? "settled" : "reconciliation_required", Number(usage !== undefined), usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage === undefined ? null : JSON.stringify(usage), id);
      this.audit("operator", "request.resolve", id, { occupancyReleased: true, usage: usage ?? "unknown reservation retained" });
    });
  }
  expire(id: string, state: "expired" | "deleted"): void { this.transaction(() => { const row = this.request(id); if (row.outcome === "running") throw new Error("cannot remove an active capture"); this.database.prepare("UPDATE requests SET capture_state=?,capture_complete=0,capture_bytes=0 WHERE id=?").run(state, id); this.audit("operator", `capture.${state}`, id); }); }
  usage(projectId: string, serviceLimits?: RouterLimits): Record<string, unknown> {
    const project = this.project(projectId), day = new Date(this.now()).toISOString().slice(0, 10);
    const aggregate = this.database.prepare(`SELECT COUNT(*) AS requests,SUM(input_tokens) AS knownInputTokens,SUM(output_tokens) AS knownOutputTokens,
      SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) AS unknownUsageRequests,SUM(capture_bytes) AS captureBytes,
      SUM(occupied) AS occupied,SUM(dispatched) AS backendDispatches,SUM(token_reservation) AS tokenReservations FROM requests WHERE project_id=?`).get(projectId);
    const recent = this.database.prepare(`SELECT id,principal_id AS principalId,workspace_id AS workspaceId,route_id AS route,account_id AS accountId,attempt_id AS attemptId,requested_model AS requestedModel,
      observed_model AS observedModel,started_at AS startedAt,finished_at AS finishedAt,outcome,execution,delivery,accounting,capture_state AS captureState,capture_complete AS captureComplete,
      input_tokens AS inputTokens,output_tokens AS outputTokens,error_code AS errorCode FROM requests WHERE project_id=? ORDER BY started_at DESC,rowid DESC LIMIT 100`).all(projectId);
    const today = this.database.prepare("SELECT COUNT(*) AS requests,COALESCE(SUM(CASE WHEN input_tokens IS NULL THEN token_reservation ELSE input_tokens+output_tokens END),0) AS chargedTokens,COALESCE(SUM(token_reservation),0) AS tokenReservations,SUM(CASE WHEN dispatched=1 AND input_tokens IS NULL AND token_reservation=0 THEN 1 ELSE 0 END) AS uncoveredUnknowns FROM requests WHERE project_id=? AND day=?").get(projectId, day);
    const service = this.database.prepare("SELECT COUNT(*) AS requests FROM requests WHERE day=?").get(day);
    const serviceActive = Number(this.database.prepare("SELECT COUNT(*) AS n FROM requests WHERE occupied=1").get()?.n);
    const remainingRequests = Math.max(0, Math.min(project.policy.limits.requestsPerUtcDay - Number(today?.requests), serviceLimits === undefined ? Number.MAX_SAFE_INTEGER : serviceLimits.requestsPerUtcDay - Number(service?.requests)));
    const allowance = { utcDay: day, enabled: project.enabled, paused: project.paused, booking: "admission", projectLimits: project.policy.limits, serviceLimits: serviceLimits ?? "not supplied to this local read",
      admittedRequests: Number(today?.requests), remainingRequests, occupied: Number(aggregate?.occupied ?? 0), serviceOccupied: serviceActive,
      tokenMode: project.policy.tokenMode, tokenLimit: project.policy.tokensPerUtcDay ?? null, chargedTokensOrEstimates: Number(today?.chargedTokens),
      unknownUnreservedRequests: Number(today?.uncoveredUnknowns ?? 0), tokenReservations: Number(today?.tokenReservations),
      tokenAllowanceStatus: Number(today?.uncoveredUnknowns ?? 0) > 0 ? "blocked_pending_reconciliation" : project.policy.tokenMode === "estimate" ? "estimate_overshoot_possible" : "observe_only",
      remainingEstimatedTokens: project.policy.tokensPerUtcDay === undefined || Number(today?.uncoveredUnknowns ?? 0) > 0 ? null : Math.max(0, project.policy.tokensPerUtcDay - Number(today?.chargedTokens)),
      estimatedTokenOverage: project.policy.tokensPerUtcDay === undefined ? null : Math.max(0, Number(today?.chargedTokens) - project.policy.tokensPerUtcDay) };
    return { projectId, ...object(aggregate), allowance, recent, observedAt: this.now(), period: "UTC calendar day; booking at admission", attemptVisibility: "backend request only; hidden retries/attempts unobserved",
      accounting: "local service traffic; provider subscription allowance is not inferred" };
  }
  captureUsage(projectId: string): number { return this.captureBytes(projectId); }
  private captureBytes(projectId: string): number { return Number(this.database.prepare("SELECT COALESCE(SUM(capture_bytes),0) AS n FROM requests WHERE project_id=?").get(projectId)?.n); }
  private transaction<T>(operation: () => T): T { this.database.exec("BEGIN IMMEDIATE"); try { const result = operation(); this.database.exec("COMMIT"); return result; } catch (error) { this.database.exec("ROLLBACK"); throw error; } }
}
export function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
