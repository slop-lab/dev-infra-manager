import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";

export type StoredOrdinaryPoolClaim = {
  readonly claimId: string;
  readonly jobId: number;
  readonly projectId: string;
  readonly hostId: string;
  readonly capacity: string;
  readonly requestId: string;
  readonly leaseExpiresAt: number;
};

export type OrdinaryCiPoolLease = {
  readonly leaseMilliseconds: number;
  readonly now: () => number;
};

export class OrdinaryCiPoolStore {
  readonly #database: DatabaseSync;
  readonly #lease: OrdinaryCiPoolLease;

  constructor(file: string, lease: OrdinaryCiPoolLease) {
    if (!Number.isSafeInteger(lease.leaseMilliseconds) || lease.leaseMilliseconds < 1) {
      throw new UserError("ordinary CI pool lease duration must be a positive integer");
    }
    this.#lease = lease;
    this.#database = new DatabaseSync(file);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS queued_jobs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        job_id INTEGER NOT NULL,
        UNIQUE(project_id, job_id)
      );
      CREATE TABLE IF NOT EXISTS completed_jobs (
        project_id TEXT NOT NULL,
        job_id INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY(project_id, job_id)
      );
      CREATE TABLE IF NOT EXISTS claims (
        claim_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        job_id INTEGER NOT NULL,
        host_id TEXT NOT NULL,
        capacity TEXT NOT NULL,
        request_id TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        UNIQUE(host_id, capacity),
        UNIQUE(host_id, request_id),
        UNIQUE(project_id, job_id)
      );
    `);
  }

  close(): void { this.#database.close(); }

  recordQueued(projectId: string, jobId: number): void {
    this.#database.prepare(`
      INSERT OR IGNORE INTO queued_jobs(project_id, job_id)
      SELECT ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM claims WHERE project_id = ? AND job_id = ?
      ) AND NOT EXISTS (
        SELECT 1 FROM completed_jobs WHERE project_id = ? AND job_id = ?
      )
    `).run(projectId, jobId, projectId, jobId, projectId, jobId);
  }

  recordTerminal(projectId: string, jobId: number, completed: boolean): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("DELETE FROM queued_jobs WHERE project_id = ? AND job_id = ?").run(projectId, jobId);
      this.#database.prepare(`
        INSERT INTO completed_jobs(project_id, job_id, completed) VALUES (?, ?, ?)
        ON CONFLICT(project_id, job_id) DO UPDATE SET
          completed_at = CASE WHEN completed_jobs.completed = 1 THEN completed_jobs.completed_at ELSE excluded.completed_at END,
          completed = MAX(completed_jobs.completed, excluded.completed)
      `).run(projectId, jobId, completed ? 1 : 0);
      this.#database.prepare("DELETE FROM completed_jobs WHERE completed = 1 AND completed_at < unixepoch() - 604800").run();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  claim(hostId: string, capacity: string, requestId: string): StoredOrdinaryPoolClaim | undefined {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare(
        "SELECT * FROM claims WHERE host_id = ? AND request_id = ? AND lease_expires_at > ?"
      ).get(hostId, requestId, this.#lease.now());
      if (existing !== undefined) {
        this.#database.exec("COMMIT");
        return parseClaim(existing);
      }
      const occupied = this.#database.prepare(
        "SELECT 1 AS occupied FROM claims WHERE host_id = ? AND capacity = ?"
      ).get(hostId, capacity);
      if (occupied !== undefined) {
        this.#database.exec("COMMIT");
        return undefined;
      }
      const job = this.#database.prepare(
        "SELECT project_id, job_id FROM queued_jobs ORDER BY sequence LIMIT 1"
      ).get();
      if (job === undefined) {
        this.#database.exec("COMMIT");
        return undefined;
      }
      const parsedJob = parseJob(job);
      const claim = {
        claimId: randomBytes(24).toString("hex"),
        projectId: parsedJob.projectId,
        jobId: parsedJob.jobId,
        hostId,
        capacity,
        requestId,
        leaseExpiresAt: this.#lease.now() + this.#lease.leaseMilliseconds
      } satisfies StoredOrdinaryPoolClaim;
      this.#database.prepare("DELETE FROM queued_jobs WHERE project_id = ? AND job_id = ?")
        .run(claim.projectId, claim.jobId);
      this.#database.prepare(`
        INSERT INTO claims(claim_id, project_id, job_id, host_id, capacity, request_id, lease_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(claim.claimId, claim.projectId, claim.jobId, hostId, capacity, requestId, claim.leaseExpiresAt);
      this.#database.exec("COMMIT");
      return claim;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  expired(hostId: string, capacity: string): StoredOrdinaryPoolClaim | undefined {
    const value = this.#database.prepare(
      "SELECT * FROM claims WHERE host_id = ? AND capacity = ? AND lease_expires_at <= ?"
    ).get(hostId, capacity, this.#lease.now());
    return value === undefined ? undefined : parseClaim(value);
  }

  renew(claimId: string, hostId: string): number | undefined {
    const now = this.#lease.now();
    const leaseExpiresAt = now + this.#lease.leaseMilliseconds;
    const result = this.#database.prepare(`
      UPDATE claims SET lease_expires_at = ?
      WHERE claim_id = ? AND host_id = ? AND lease_expires_at > ?
        AND NOT EXISTS (
          SELECT 1 FROM completed_jobs
          WHERE project_id = claims.project_id AND job_id = claims.job_id AND completed = 1
        )
    `).run(leaseExpiresAt, claimId, hostId, now);
    return result.changes === 1 ? leaseExpiresAt : undefined;
  }

  recover(claimId: string, hostId: string, capacity: string): boolean {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = this.#database.prepare(`
        SELECT * FROM claims
        WHERE claim_id = ? AND host_id = ? AND capacity = ? AND lease_expires_at <= ?
      `).get(claimId, hostId, capacity, this.#lease.now());
      if (value === undefined) {
        this.#database.exec("COMMIT");
        return false;
      }
      const claim = parseClaim(value);
      this.#database.prepare(`
        INSERT OR IGNORE INTO queued_jobs(project_id, job_id)
        SELECT ?, ? WHERE NOT EXISTS (
          SELECT 1 FROM completed_jobs WHERE project_id = ? AND job_id = ?
        )
      `).run(claim.projectId, claim.jobId, claim.projectId, claim.jobId);
      this.#database.prepare("DELETE FROM claims WHERE claim_id = ?").run(claimId);
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  release(claimId: string, hostId: string): boolean {
    const result = this.#database.prepare(
      "DELETE FROM claims WHERE claim_id = ? AND host_id = ?"
    ).run(claimId, hostId);
    return result.changes === 1;
  }
}

function parseJob(value: unknown): { readonly projectId: string; readonly jobId: number } {
  if (!isRecord(value) || typeof value.project_id !== "string"
    || !Number.isSafeInteger(value.job_id) || Number(value.job_id) <= 0) {
    throw new UserError("ordinary CI pool database contains an invalid queued job");
  }
  return { projectId: value.project_id, jobId: Number(value.job_id) };
}

function parseClaim(value: unknown): StoredOrdinaryPoolClaim {
  if (!isRecord(value) || typeof value.claim_id !== "string" || typeof value.project_id !== "string"
    || typeof value.host_id !== "string" || typeof value.capacity !== "string" || typeof value.request_id !== "string"
    || !Number.isSafeInteger(value.job_id) || Number(value.job_id) <= 0
    || !Number.isSafeInteger(value.lease_expires_at) || Number(value.lease_expires_at) <= 0) {
    throw new UserError("ordinary CI pool database contains an invalid claim");
  }
  return {
    claimId: value.claim_id,
    projectId: value.project_id,
    jobId: Number(value.job_id),
    hostId: value.host_id,
    capacity: value.capacity,
    requestId: value.request_id,
    leaseExpiresAt: Number(value.lease_expires_at)
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
