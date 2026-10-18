import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executionEventSchema, executionGrantSchema, executionResultSchema } from "@slop-lab/dim-native-git/execution";
import { ExecutionConflictError, type Execution, type ExecutionAssignment, type ExecutionEvent,
  type ExecutionGrant, type ExecutionResult, type WorkerSlot } from "./execution.js";

export class ExecutionStore {
  readonly database: DatabaseSync;
  constructor(path: string, readonly generationId: string, readonly leaseMilliseconds: number,
    readonly now: () => number = Date.now) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()) throw new Error("CI state directory is not owned");
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error("CI database is not owned");
    }
    this.database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version);
    if (version !== 0 && version !== 101) throw new Error("CI state format is unsupported; use a fresh CI state directory");
    if (version === 0) this.database.exec(`BEGIN IMMEDIATE;
      CREATE TABLE executions (id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, phase TEXT NOT NULL,
        worker_id TEXT, slot_id TEXT, request_id TEXT, created_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX occupied_slot ON executions(worker_id,slot_id) WHERE phase IN ('assigned','running','recovering');
      CREATE UNIQUE INDEX reservation_request ON executions(worker_id,slot_id,request_id) WHERE request_id IS NOT NULL;
      CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      PRAGMA user_version=101; COMMIT;`);
    this.transaction(() => {
      for (const execution of this.list()) if (execution.generationId !== generationId
        && (execution.phase === "assigned" || execution.phase === "running")) this.save({ ...execution, phase: "recovering" });
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
      const row = this.database.prepare("SELECT body FROM executions WHERE event_id=?").get(event.eventId);
      if (row !== undefined) {
        const existing = decode(row);
        if (!isDeepStrictEqual(existing.event, event)) throw new ExecutionConflictError("event identity conflicts");
        return existing;
      }
      const execution: Execution = { id: randomUUID(), event, phase: "queued", generationId: this.generationId,
        createdAt: this.now(), publication: "pending" };
      this.database.prepare("INSERT INTO executions(id,event_id,phase,created_at,body) VALUES (?,?,'queued',?,?)")
        .run(execution.id, event.eventId, execution.createdAt, JSON.stringify(execution));
      return execution;
    });
  }
  reserve(workerId: string, slot: WorkerSlot, requestId: string): ExecutionAssignment | undefined {
    return this.transaction(() => {
      this.expire();
      const replay = this.database.prepare("SELECT body FROM executions WHERE worker_id=? AND slot_id=? AND request_id=?")
        .get(workerId, slot.id, requestId);
      if (replay !== undefined) return decode(replay) as ExecutionAssignment;
      const occupied = this.database.prepare("SELECT 1 FROM executions WHERE worker_id=? AND slot_id=? AND phase<>'finished'")
        .get(workerId, slot.id);
      if (occupied !== undefined) throw new ExecutionConflictError("slot needs completion or owned cleanup");
      const queued = this.list().find((job) => job.phase === "queued" && job.event.executionKind === slot.kind);
      if (queued === undefined) return undefined;
      const assigned: ExecutionAssignment = { ...queued, generationId: this.generationId, phase: "assigned",
        workerId, slotId: slot.id, requestId, profile: slot.profile,
        leaseToken: randomBytes(32).toString("base64url"), leaseExpiresAt: this.now() + this.leaseMilliseconds };
      this.save(assigned);
      return assigned;
    });
  }
  attachGrant(id: string, grant: ExecutionGrant): ExecutionAssignment {
    const selected = this.get(id);
    if (selected.phase !== "assigned" || grant.executionId !== id) throw new ExecutionConflictError("execution authorization conflicts");
    const saved = { ...selected, grant: executionGrantSchema.parse(grant) } as ExecutionAssignment;
    this.save(saved); return saved;
  }
  renew(id: string, workerId: string, slotId: string, token: string): ExecutionAssignment {
    return this.transaction(() => {
      this.expire();
      const execution = this.owned(id, workerId, slotId, token);
      if (execution.generationId !== this.generationId || !["assigned", "running"].includes(execution.phase)) {
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
  pendingResults(): Execution[] { return this.list().filter((execution) => execution.phase === "finished"
    && execution.result !== undefined && execution.publication === "pending"); }
  get(id: string): Execution {
    const row = this.database.prepare("SELECT body FROM executions WHERE id=?").get(id);
    if (row === undefined) throw new ExecutionConflictError("execution was not found");
    return decode(row);
  }
  list(): Execution[] { return this.database.prepare("SELECT body FROM executions ORDER BY created_at,rowid").all().map(decode); }
  owned(id: string, workerId: string, slotId: string, token: string): ExecutionAssignment {
    const execution = this.get(id);
    const a = Buffer.from(token), b = Buffer.from(execution.leaseToken ?? "");
    if (execution.workerId !== workerId || execution.slotId !== slotId || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ExecutionConflictError("execution is owned by another worker or lease");
    }
    return execution as ExecutionAssignment;
  }
  private expire(): void {
    for (const execution of this.list()) if (["assigned", "running"].includes(execution.phase)
      && (execution.leaseExpiresAt ?? 0) <= this.now()) this.save({ ...execution, phase: "recovering" });
  }
  private save(execution: Execution): void {
    this.database.prepare("UPDATE executions SET phase=?,worker_id=?,slot_id=?,request_id=?,body=? WHERE id=?")
      .run(execution.phase, execution.workerId ?? null, execution.slotId ?? null, execution.requestId ?? null,
        JSON.stringify(execution), execution.id);
  }
  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}
function decode(row: unknown): Execution {
  if (row === null || typeof row !== "object" || typeof Reflect.get(row, "body") !== "string") throw new Error("CI state row is invalid");
  const value = JSON.parse(Reflect.get(row, "body"));
  executionEventSchema.parse(value.event);
  if (value.grant !== undefined) executionGrantSchema.parse(value.grant);
  if (value.result !== undefined) executionResultSchema.parse(value.result);
  return value;
}
