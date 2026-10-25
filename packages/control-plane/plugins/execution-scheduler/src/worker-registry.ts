import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executionWorkerEnrollmentSchema, executionWorkerEnrollmentSecretSchema } from "@slop-lab/dim-contracts-ci/worker";
import { ExecutionConflictError } from "@slop-lab/dim-contracts-execution";
import type { ExecutionServiceConfig } from "./config.js";

export type WorkerEnrollment = ReturnType<typeof executionWorkerEnrollmentSecretSchema.parse>;

export class WorkerRegistry {
  readonly #lastSeen = new Map<string, number>();
  constructor(private readonly database: DatabaseSync, private readonly generationId: string,
    private readonly config: ExecutionServiceConfig, private readonly now: () => number) { this.assertAuthority(); }

  workers(): readonly WorkerEnrollment[] {
    const enrolled = this.database.prepare("SELECT body FROM enrolled_workers WHERE generation_id=? ORDER BY worker_id")
      .all(this.generationId).map((row) => executionWorkerEnrollmentSecretSchema.parse(JSON.parse(String(row.body))));
    return [...this.config.workers.map((worker) => executionWorkerEnrollmentSecretSchema.parse({
      schemaVersion: 1, workerId: worker.id, generationId: this.generationId, token: worker.token, slots: worker.slots
    })), ...enrolled];
  }

  enroll(input: unknown): WorkerEnrollment {
    const registration = executionWorkerEnrollmentSchema.parse(input);
    const nativeCredentials = this.config.nativeGit === undefined ? [] : [this.config.nativeGit.grantIssuer,
      this.config.nativeGit.candidateReader, this.config.nativeGit.resultReporter];
    const serviceCredentials = [...Object.values(this.config.credentials).filter((value) => value !== undefined), ...nativeCredentials];
    if (serviceCredentials.some((credential) => credential.username === registration.workerId)) {
      throw new ExecutionConflictError("worker identity conflicts with a service role");
    }
    if (registration.slots.some((slot) => "runtime" in slot)
      && (this.config.nativeGit === undefined || this.config.credentials.webhook === undefined)) {
      throw new ExecutionConflictError("CI slots require native Git execution authority");
    }
    if (registration.slots.some((slot) => "taskType" in slot) && this.config.credentials.tasks === undefined) {
      throw new ExecutionConflictError("task slots require task issuer authority");
    }
    if (this.workers().some((worker) => worker.workerId === registration.workerId)) {
      throw new ExecutionConflictError("worker identity is already enrolled");
    }
    let token = randomBytes(32).toString("base64url");
    while (serviceCredentials.some((credential) => credential.password === token)
      || this.workers().some((worker) => worker.token === token)) token = randomBytes(32).toString("base64url");
    const enrolled = executionWorkerEnrollmentSecretSchema.parse({ ...registration, generationId: this.generationId, token });
    this.database.prepare("INSERT INTO enrolled_workers(worker_id,generation_id,body) VALUES (?,?,?)")
      .run(enrolled.workerId, this.generationId, JSON.stringify(enrolled));
    return enrolled;
  }

  export(workerId: string): WorkerEnrollment {
    const row = this.database.prepare("SELECT body FROM enrolled_workers WHERE worker_id=? AND generation_id=?").get(workerId, this.generationId);
    if (row === undefined) throw new ExecutionConflictError("worker is not enrolled");
    return executionWorkerEnrollmentSecretSchema.parse(JSON.parse(String(row.body)));
  }

  authenticate(workerId: string, token: string): WorkerEnrollment | undefined {
    return this.workers().find((worker) => worker.workerId === workerId && equal(worker.token, token));
  }

  authenticateAuthorization(header: string | undefined): WorkerEnrollment | undefined {
    if (header === undefined || !header.startsWith("Basic ")) return undefined;
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8"), separator = decoded.indexOf(":");
    return separator < 1 ? undefined : this.authenticate(decoded.slice(0, separator), decoded.slice(separator + 1));
  }

  observe(workerId: string): void { this.#lastSeen.set(workerId, this.now()); }
  lastSeenAt(workerId: string): number | undefined { return this.#lastSeen.get(workerId); }
  observed(workerId: string): boolean {
    const seen = this.lastSeenAt(workerId);
    return seen !== undefined && this.now() - seen <= this.config.claimLeaseMilliseconds;
  }

  private assertAuthority(): void {
    const nativeCredentials = this.config.nativeGit === undefined ? [] : [this.config.nativeGit.grantIssuer,
      this.config.nativeGit.candidateReader, this.config.nativeGit.resultReporter];
    const roles = [...Object.values(this.config.credentials).filter((value) => value !== undefined), ...nativeCredentials];
    const values = [...roles.flatMap((credential) => [credential.username, credential.password]),
      ...this.workers().flatMap((worker) => [worker.workerId, worker.token])];
    if (new Set(values).size !== values.length) throw new Error("enrolled worker authority conflicts with a service role or worker identity");
  }
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
