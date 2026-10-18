import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executionEventSchema, executionGrantSchema } from "@slop-lab/dim-native-git/execution";
import { executionResultSchema, parseExecution, ExecutionConflictError, type Execution, type ExecutionAssignment, type ExecutionEvent,
  type ExecutionGrant, type ExecutionResult, type WorkerSlot } from "./execution.js";

export class ExecutionStore {
  readonly database: DatabaseSync;
  constructor(path: string, readonly generationId: string, readonly leaseMilliseconds: number,
    readonly now: () => number = Date.now) {
    if (!/^[0-9a-f]{64}$/.test(generationId) || !Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
      throw new Error("CI generation or lease duration is invalid");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()
      || (parent.mode & 0o022) !== 0) throw new Error("CI state directory is not owned");
    const known = new Set([basename(path), `${basename(path)}-wal`, `${basename(path)}-shm`]);
    for (const name of readdirSync(dirname(path))) {
      if (!known.has(name)) throw new Error("CI state is unsupported; select a fresh CI state directory");
      const metadata = lstatSync(`${dirname(path)}/${name}`);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || metadata.nlink !== 1) {
        throw new Error("CI state file is not an owned regular file");
      }
    }
    this.database = new DatabaseSync(path);
    const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== 101 && (version !== 0 || this.database.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get() !== undefined)) {
      this.database.close(); throw new Error("CI state format is unsupported; use a fresh CI state directory");
    }
    chmodSync(path, 0o600);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    if (version === 0) this.database.exec(`BEGIN IMMEDIATE;
      CREATE TABLE executions (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, generation_id TEXT NOT NULL, phase TEXT NOT NULL,
        worker_id TEXT, slot_id TEXT, request_id TEXT, created_at INTEGER NOT NULL,
        execution_kind TEXT NOT NULL, publication TEXT NOT NULL, lease_expires_at INTEGER, body TEXT NOT NULL);
      CREATE UNIQUE INDEX event_generation ON executions(event_id,generation_id);
      CREATE UNIQUE INDEX occupied_slot ON executions(worker_id,slot_id) WHERE phase IN ('assigned','running','recovering');
      CREATE UNIQUE INDEX reservation_request ON executions(worker_id,slot_id,request_id) WHERE request_id IS NOT NULL;
      CREATE INDEX queued_jobs ON executions(execution_kind,created_at) WHERE phase='queued';
      CREATE INDEX pending_results ON executions(created_at) WHERE phase='finished' AND publication='pending';
      CREATE INDEX lease_expiry ON executions(lease_expires_at) WHERE phase IN ('assigned','running');
      CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      PRAGMA user_version=101; COMMIT;`);
    for (const row of this.database.prepare("SELECT * FROM executions").iterate()) decode(row);
    this.transaction(() => {
      for (const row of this.database.prepare("SELECT * FROM executions WHERE phase IN ('queued','assigned','running')").all()) {
        const execution = decode(row);
        if (execution.generationId !== generationId) this.save(execution.phase === "queued"
          ? { ...execution, phase: "finished", publication: "stale" } : { ...execution, phase: "recovering" });
      }
    });
  }
  close(): void { this.database.close(); }
  activated(tokenDigest: string): boolean {
    return this.database.prepare("SELECT 1 FROM metadata WHERE key='activation' AND value=?")
      .get(`${this.generationId}:${tokenDigest}`) !== undefined;
  }
  activate(tokenDigest: string): void {
    this.database.prepare("INSERT INTO metadata VALUES ('activation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(`${this.generationId}:${tokenDigest}`);
  }
  enqueue(input: ExecutionEvent): Execution {
    const event = executionEventSchema.parse(input);
    return this.transaction(() => {
      const row = this.database.prepare("SELECT * FROM executions WHERE event_id=? AND generation_id=?").get(event.eventId, this.generationId);
      if (row !== undefined) {
        const existing = decode(row);
        if (!isDeepStrictEqual(existing.event, event)) throw new ExecutionConflictError("event identity conflicts");
        return existing;
      }
      const execution: Execution = { id: randomUUID(), event, phase: "queued", generationId: this.generationId,
        createdAt: this.now(), publication: "pending" };
      this.database.prepare("INSERT INTO executions(id,event_id,generation_id,phase,created_at,execution_kind,publication,body) VALUES (?,?,?,'queued',?,?,'pending',?)")
        .run(execution.id, event.eventId, this.generationId, execution.createdAt, event.executionKind, JSON.stringify(execution));
      return execution;
    });
  }
  reserve(workerId: string, slot: WorkerSlot, requestId: string): ExecutionAssignment | undefined {
    return this.transaction(() => {
      this.expire();
      const replay = this.database.prepare("SELECT * FROM executions WHERE worker_id=? AND slot_id=? AND request_id=?")
        .get(workerId, slot.id, requestId);
      if (replay !== undefined) return decode(replay) as ExecutionAssignment;
      const occupied = this.database.prepare("SELECT 1 FROM executions WHERE worker_id=? AND slot_id=? AND phase<>'finished'")
        .get(workerId, slot.id);
      if (occupied !== undefined) throw new ExecutionConflictError("slot needs completion or owned cleanup");
      const row = this.database.prepare("SELECT * FROM executions WHERE phase='queued' AND execution_kind=? AND generation_id=? ORDER BY created_at,rowid LIMIT 1").get(slot.kind, this.generationId);
      if (row === undefined) return undefined;
      const queued = decode(row);
      const assigned: ExecutionAssignment = { ...queued, generationId: this.generationId, phase: "assigned",
        workerId, slotId: slot.id, requestId, profile: slot.profile,
        leaseToken: randomBytes(32).toString("base64url"), leaseExpiresAt: this.now() + this.leaseMilliseconds };
      this.save(assigned);
      return assigned;
    });
  }
  attachGrant(id: string, grant: ExecutionGrant): ExecutionAssignment {
    const selected = this.get(id);
    if (selected.grant !== undefined) {
      if (!isDeepStrictEqual(selected.grant, grant)) throw new ExecutionConflictError("execution authorization conflicts");
      return selected as ExecutionAssignment;
    }
    if (selected.phase !== "assigned" || grant.executionId !== id) throw new ExecutionConflictError("execution authorization conflicts");
    const saved = { ...selected, grant: executionGrantSchema.parse(grant) } as ExecutionAssignment;
    this.save(saved); return saved;
  }
  renew(id: string, workerId: string, slotId: string, token: string): ExecutionAssignment {
    return this.transaction(() => {
      this.expire();
      const execution = this.owned(id, workerId, slotId, token);
      if (execution.grant === undefined || execution.generationId !== this.generationId || !["assigned", "running"].includes(execution.phase)) {
        throw new ExecutionConflictError("execution lease is no longer current");
      }
      const saved = { ...execution, phase: "running" as const, leaseExpiresAt: this.now() + this.leaseMilliseconds };
      this.save(saved); return saved;
    });
  }
  finish(id: string, workerId: string, slotId: string, token: string, input: ExecutionResult): Execution {
    return this.transaction(() => {
      const execution = this.owned(id, workerId, slotId, token);
      const result = executionResultSchema.parse(input);
      if (result.executionId !== id || result.descriptorDigest !== execution.grant?.descriptorDigest) {
        throw new ExecutionConflictError("result does not match execution");
      }
      if (execution.result !== undefined) {
        if (!isDeepStrictEqual(execution.result, result)) throw new ExecutionConflictError("result conflicts");
        return execution;
      }
      if (!["assigned", "running", "recovering"].includes(execution.phase)) throw new ExecutionConflictError("execution is already closed");
      const saved: Execution = { ...execution, phase: "finished", result };
      this.save(saved); return saved;
    });
  }
  recover(id: string, workerId: string, slotId: string, token: string): Execution {
    return this.transaction(() => {
      const execution = this.owned(id, workerId, slotId, token);
      if (execution.phase === "finished") return execution;
      const saved: Execution = { ...execution, phase: "finished", publication: "stale" };
      this.save(saved); return saved;
    });
  }
  reject(id: string): void { const execution = this.get(id); this.save({ ...execution, phase: "finished", publication: "stale" }); }
  published(id: string, publication: "accepted" | "stale"): void { this.save({ ...this.get(id), publication }); }
  pendingResults(): Execution[] {
    return this.database.prepare("SELECT * FROM executions WHERE phase='finished' AND publication='pending' ORDER BY created_at,rowid LIMIT 100").all().map(decode);
  }
  get(id: string): Execution {
    const row = this.database.prepare("SELECT * FROM executions WHERE id=?").get(id);
    if (row === undefined) throw new ExecutionConflictError("execution was not found");
    return decode(row);
  }
  list(limit = 100): Execution[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("CI history query limit is invalid");
    return this.database.prepare("SELECT * FROM executions ORDER BY created_at DESC,rowid DESC LIMIT ?").all(limit).map(decode);
  }
  owned(id: string, workerId: string, slotId: string, token: string): ExecutionAssignment {
    const execution = this.get(id);
    const a = Buffer.from(token), b = Buffer.from(execution.leaseToken ?? "");
    if (execution.workerId !== workerId || execution.slotId !== slotId || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ExecutionConflictError("execution is owned by another worker or lease");
    }
    return execution as ExecutionAssignment;
  }
  private expire(): void {
    const expired = this.database.prepare("SELECT * FROM executions WHERE phase IN ('assigned','running') AND lease_expires_at<=?").all(this.now());
    for (const row of expired) this.save({ ...decode(row), phase: "recovering" });
  }
  private save(execution: Execution): void {
    parseExecution(execution);
    this.database.prepare("UPDATE executions SET phase=?,worker_id=?,slot_id=?,request_id=?,publication=?,lease_expires_at=?,body=? WHERE id=?")
      .run(execution.phase, execution.workerId ?? null, execution.slotId ?? null, execution.requestId ?? null,
        execution.publication, execution.leaseExpiresAt ?? null, JSON.stringify(execution), execution.id);
  }
  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}
function decode(row: unknown): Execution {
  if (row === null || typeof row !== "object" || typeof Reflect.get(row, "body") !== "string") throw new Error("CI state row is invalid");
  const value = parseExecution(JSON.parse(Reflect.get(row, "body")));
  const fields = { id: value.id, event_id: value.event.eventId, generation_id: value.generationId, phase: value.phase, worker_id: value.workerId ?? null,
    slot_id: value.slotId ?? null, request_id: value.requestId ?? null, created_at: value.createdAt, execution_kind: value.event.executionKind,
    publication: value.publication, lease_expires_at: value.leaseExpiresAt ?? null };
  if (Object.entries(fields).some(([key, expected]) => Reflect.get(row, key) !== expected)) throw new Error("CI execution indexes disagree with state");
  return value;
}
