import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { ExecutionConflictError, type AssignmentOwnership, type ScheduledJob, type ScheduledSlot, type SchedulingEvent, type SchedulingGrant, type SchedulingResult } from "@slop-lab/dim-contracts-execution";

export type SchedulingCodec<E, G, R, J> = {
  parseEvent(value: unknown): E; parseGrant(value: unknown): G; parseResult(value: unknown): R; parseJob(value: unknown): J;
  matchesProfile?(event: E, profile: object): boolean;
};
export class TaskStore<E extends SchedulingEvent, P extends object, G extends SchedulingGrant, R extends SchedulingResult,
  J extends ScheduledJob<E, P, G, R> = ScheduledJob<E, P, G, R>> {
  readonly database: DatabaseSync;
  constructor(path: string, readonly generationId: string, readonly leaseMilliseconds: number,
    readonly codec: SchedulingCodec<E, G, R, J>, readonly now: () => number = Date.now) {
    if (!/^[0-9a-f]{64}$/.test(generationId) || !Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
      throw new Error("task generation or lease duration is invalid");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()
      || (parent.mode & 0o022) !== 0) throw new Error("task state directory is not owned");
    const known = new Set([basename(path), `${basename(path)}-wal`, `${basename(path)}-shm`]);
    for (const name of readdirSync(dirname(path))) {
      if (!known.has(name)) throw new Error("task state is unsupported; select a fresh task state directory");
      const metadata = lstatSync(`${dirname(path)}/${name}`);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || metadata.nlink !== 1) {
        throw new Error("task state file is not an owned regular file");
      }
    }
    this.database = new DatabaseSync(path);
    const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version);
    if (![102, 103].includes(version) && (version !== 0 || this.database.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get() !== undefined)) {
      this.database.close(); throw new Error("task state format is unsupported; use a fresh task state directory");
    }
    chmodSync(path, 0o600);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    if (version === 0) this.database.exec(`BEGIN IMMEDIATE;
      CREATE TABLE executions (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, generation_id TEXT NOT NULL, phase TEXT NOT NULL, retry_of TEXT,
        worker_id TEXT, slot_id TEXT, request_id TEXT, created_at INTEGER NOT NULL,
        execution_kind TEXT NOT NULL, publication TEXT NOT NULL, lease_expires_at INTEGER, body TEXT NOT NULL);
      CREATE UNIQUE INDEX event_generation ON executions(event_id,generation_id) WHERE retry_of IS NULL;
      CREATE UNIQUE INDEX retry_request ON executions(retry_of,json_extract(body,'$.retryRequestId')) WHERE retry_of IS NOT NULL;
      CREATE UNIQUE INDEX occupied_slot ON executions(worker_id,slot_id) WHERE phase IN ('assigned','running','recovering');
      CREATE UNIQUE INDEX reservation_request ON executions(worker_id,slot_id,request_id) WHERE request_id IS NOT NULL;
      CREATE INDEX queued_jobs ON executions(execution_kind,created_at) WHERE phase='queued';
      CREATE INDEX pending_results ON executions(created_at) WHERE phase='finished' AND publication='pending';
      CREATE INDEX lease_expiry ON executions(lease_expires_at) WHERE phase IN ('assigned','running');
      CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE enrolled_workers (worker_id TEXT NOT NULL, generation_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(worker_id,generation_id));
      PRAGMA user_version=103; COMMIT;`);
    if (version === 102) this.database.exec(`BEGIN IMMEDIATE;
      CREATE TABLE enrolled_workers (worker_id TEXT NOT NULL, generation_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(worker_id,generation_id));
      PRAGMA user_version=103; COMMIT;`);
    for (const row of this.database.prepare("SELECT * FROM executions").iterate()) this.decode(row);
    this.transaction(() => {
      for (const row of this.database.prepare("SELECT * FROM executions WHERE phase IN ('queued','assigned','running')").all()) {
        const execution = this.decode(row);
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
  enqueue(input: E): J {
    const event = this.codec.parseEvent(input);
    return this.transaction(() => {
      const row = this.database.prepare("SELECT * FROM executions WHERE event_id=? AND generation_id=? AND retry_of IS NULL").get(event.eventId, this.generationId);
      if (row !== undefined) {
        const existing = this.decode(row);
        if (!isDeepStrictEqual(existing.event, event)) throw new ExecutionConflictError("event identity conflicts");
        return existing;
      }
      const execution = this.codec.parseJob({ id: randomUUID(), event, phase: "queued", generationId: this.generationId,
        createdAt: this.now(), publication: "pending" });
      this.database.prepare("INSERT INTO executions(id,event_id,generation_id,phase,created_at,execution_kind,publication,body) VALUES (?,?,?,'queued',?,?,'pending',?)")
        .run(execution.id, event.eventId, this.generationId, execution.createdAt, event.executionKind, JSON.stringify(execution));
      return execution;
    });
  }
  reserve(workerId: string, slot: ScheduledSlot<P>, requestId: string): (J & AssignmentOwnership<P>) | undefined {
    this.expire();
    return this.transaction(() => {
      const replay = this.database.prepare("SELECT * FROM executions WHERE worker_id=? AND slot_id=? AND request_id=?")
        .get(workerId, slot.id, requestId);
      if (replay !== undefined) return this.decode(replay) as (J & AssignmentOwnership<P>);
      const occupied = this.database.prepare("SELECT 1 FROM executions WHERE worker_id=? AND slot_id=? AND phase<>'finished'")
        .get(workerId, slot.id);
      if (occupied !== undefined) throw new ExecutionConflictError("slot needs completion or owned cleanup");
      let row: unknown;
      for (const candidate of this.database.prepare("SELECT * FROM executions WHERE phase='queued' AND execution_kind=? AND generation_id=? ORDER BY created_at,rowid").iterate(slot.kind, this.generationId)) {
        if (this.codec.matchesProfile?.(this.decode(candidate).event, slot.profile) !== false) { row = candidate; break; }
      }
      if (row === undefined) return undefined;
      const queued = this.decode(row);
      const assigned: (J & AssignmentOwnership<P>) = { ...queued, generationId: this.generationId, phase: "assigned",
        workerId, slotId: slot.id, requestId, profile: slot.profile,
        leaseToken: randomBytes(32).toString("base64url"), leaseExpiresAt: this.now() + this.leaseMilliseconds };
      this.save(assigned);
      return assigned;
    });
  }
  attachGrant(id: string, grant: G): (J & AssignmentOwnership<P>) {
    this.expire();
    return this.transaction(() => {
      const selected = this.get(id);
      if (selected.grant !== undefined) {
        if (!isDeepStrictEqual(selected.grant, grant)) throw new ExecutionConflictError("execution authorization conflicts");
        return selected as (J & AssignmentOwnership<P>);
      }
      if (selected.phase !== "assigned" || selected.generationId !== this.generationId || selected.cancelRequestedAt !== undefined
        || (selected.leaseExpiresAt ?? 0) <= this.now() || grant.executionId !== id) throw new ExecutionConflictError("execution authorization conflicts");
      const saved = { ...selected, grant: this.codec.parseGrant(grant) } as (J & AssignmentOwnership<P>);
      this.save(saved); return saved;
    });
  }
  renewAdmission(id: string, workerId: string, slotId: string, token: string): (J & AssignmentOwnership<P>) {
    this.expire();
    return this.transaction(() => {
      const execution = this.owned(id, workerId, slotId, token);
      if (execution.grant !== undefined || execution.generationId !== this.generationId || execution.cancelRequestedAt !== undefined || execution.phase !== "assigned") {
        throw new ExecutionConflictError("execution admission is no longer current");
      }
      const saved = { ...execution, leaseExpiresAt: this.now() + this.leaseMilliseconds } as (J & AssignmentOwnership<P>);
      this.save(saved); return saved;
    });
  }
  renew(id: string, workerId: string, slotId: string, token: string): (J & AssignmentOwnership<P>) {
    this.expire();
    return this.transaction(() => {
      const execution = this.owned(id, workerId, slotId, token);
      if (execution.grant === undefined || execution.generationId !== this.generationId || !["assigned", "running"].includes(execution.phase)) {
        throw new ExecutionConflictError("execution lease is no longer current");
      }
      const saved = { ...execution, phase: "running" as const, leaseExpiresAt: this.now() + this.leaseMilliseconds };
      this.save(saved); return saved;
    });
  }
  finish(id: string, workerId: string, slotId: string, token: string, input: R): J {
    return this.transaction(() => {
      const execution = this.owned(id, workerId, slotId, token);
      const result = this.codec.parseResult(input);
      if (result.executionId !== id || result.descriptorDigest !== execution.grant?.descriptorDigest) {
        throw new ExecutionConflictError("result does not match execution");
      }
      if (execution.result !== undefined) {
        if (!isDeepStrictEqual(execution.result, result)) throw new ExecutionConflictError("result conflicts");
        return execution;
      }
      if (!["assigned", "running", "recovering"].includes(execution.phase)) throw new ExecutionConflictError("execution is already closed");
      const saved = this.codec.parseJob({ ...execution, phase: "finished", result,
        ...(execution.cancelRequestedAt === undefined ? {} : { publication: "stale" as const }) });
      this.save(saved); return saved;
    });
  }
  recover(id: string, workerId: string, slotId: string, token: string): J {
    return this.transaction(() => {
      const execution = this.owned(id, workerId, slotId, token);
      if (execution.phase === "finished") return execution;
      const saved = this.codec.parseJob({ ...execution, phase: "finished", publication: "stale" });
      this.save(saved); return saved;
    });
  }
  cancel(id: string): J {
    return this.transaction(() => {
      const job = this.get(id);
      if (job.generationId !== this.generationId || job.phase === "finished") throw new ExecutionConflictError("execution is not cancellable");
      const saved = this.codec.parseJob({ ...job, cancelRequestedAt: job.cancelRequestedAt ?? this.now(),
        ...(job.phase === "queued" || job.grant === undefined ? { phase: "finished", publication: "stale" } : { phase: "recovering" }) });
      this.save(saved); return saved;
    });
  }
  retry(id: string, requestId: string): J {
    return this.transaction(() => {
      const replay = this.database.prepare("SELECT * FROM executions WHERE retry_of=? AND json_extract(body,'$.retryRequestId')=?").get(id, requestId);
      if (replay !== undefined) return this.decode(replay);
      const previous = this.get(id);
      const latest = this.database.prepare("SELECT id FROM executions WHERE event_id=? AND generation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(previous.event.eventId, this.generationId);
      if (previous.generationId !== this.generationId || previous.phase !== "finished" || latest?.id !== id) throw new ExecutionConflictError("retry requires the latest finished execution after owned cleanup");
      const next = this.codec.parseJob({ id: randomUUID(), event: previous.event, generationId: this.generationId, phase: "queued",
        publication: "pending", createdAt: this.now(), retryOf: id, retryRequestId: requestId });
      this.database.prepare("INSERT INTO executions(id,event_id,generation_id,phase,retry_of,created_at,execution_kind,publication,body) VALUES (?,?,?,'queued',?,?,?,'pending',?)")
        .run(next.id, next.event.eventId, next.generationId, id, next.createdAt, next.event.executionKind, JSON.stringify(next));
      return next;
    });
  }
  occupiedSlots(): J[] {
    return this.database.prepare("SELECT * FROM executions WHERE phase IN ('assigned','running','recovering')").all().map((row) => this.decode(row));
  }
  reject(id: string): void { const execution = this.get(id); this.save({ ...execution, phase: "finished", publication: "stale" }); }
  published(id: string, publication: "accepted" | "stale"): void { this.save({ ...this.get(id), publication }); }
  pendingResults(): J[] {
    return this.database.prepare("SELECT * FROM executions WHERE phase='finished' AND publication='pending' ORDER BY created_at,rowid LIMIT 100").all().map((row) => this.decode(row));
  }
  get(id: string): J {
    const execution = this.find(id);
    if (execution === undefined) throw new ExecutionConflictError("execution was not found");
    return execution;
  }
  find(id: string): J | undefined {
    const row = this.database.prepare("SELECT * FROM executions WHERE id=?").get(id);
    return row === undefined ? undefined : this.decode(row);
  }
  list(limit = 100): J[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("task history query limit is invalid");
    return this.database.prepare("SELECT * FROM executions ORDER BY created_at DESC,rowid DESC LIMIT ?").all(limit).map((row) => this.decode(row));
  }
  owned(id: string, workerId: string, slotId: string, token: string): (J & AssignmentOwnership<P>) {
    const execution = this.get(id);
    const a = Buffer.from(token), b = Buffer.from(execution.leaseToken ?? "");
    if (execution.workerId !== workerId || execution.slotId !== slotId || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ExecutionConflictError("execution is owned by another worker or lease");
    }
    return execution as (J & AssignmentOwnership<P>);
  }
  private expire(): void {
    const expired = this.database.prepare("SELECT * FROM executions WHERE phase IN ('assigned','running') AND lease_expires_at<=?").all(this.now());
    for (const row of expired) this.save({ ...this.decode(row), phase: "recovering" });
  }
  private save(execution: ScheduledJob<E, P, G, R>): void {
    this.codec.parseJob(execution);
    this.database.prepare("UPDATE executions SET phase=?,worker_id=?,slot_id=?,request_id=?,publication=?,lease_expires_at=?,body=? WHERE id=?")
      .run(execution.phase, execution.workerId ?? null, execution.slotId ?? null, execution.requestId ?? null,
        execution.publication, execution.leaseExpiresAt ?? null, JSON.stringify(execution), execution.id);
  }
  private decode(row: unknown): J {
    if (row === null || typeof row !== "object" || typeof Reflect.get(row, "body") !== "string") throw new Error("task state row is invalid");
    const value = this.codec.parseJob(JSON.parse(Reflect.get(row, "body")));
    assertSchedulingIndexes(row, value); return value;
  }
  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}
export function assertSchedulingIndexes(row: unknown, value: { id: string; event: SchedulingEvent; generationId: string; phase: string; workerId?: string | undefined; slotId?: string | undefined; requestId?: string | undefined; createdAt: number; publication: string; leaseExpiresAt?: number | undefined; retryOf?: string | undefined }): void {
  const fields = { id: value.id, event_id: value.event.eventId, generation_id: value.generationId, phase: value.phase, worker_id: value.workerId ?? null,
    slot_id: value.slotId ?? null, request_id: value.requestId ?? null, created_at: value.createdAt, execution_kind: value.event.executionKind,
    publication: value.publication, lease_expires_at: value.leaseExpiresAt ?? null, retry_of: value.retryOf ?? null };
  if (Object.entries(fields).some(([key, expected]) => row === null || typeof row !== "object" || Reflect.get(row, key) !== expected)) throw new Error("task execution indexes disagree with state");
}
