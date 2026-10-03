import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";
import {
  ordinaryCiPoolPolicyDigest,
  type OrdinaryCiPoolAdmission,
  type OrdinaryCiPoolAdmissionInput
} from "./ordinaryCiPoolAdmission.js";
import { openOrdinaryCiPoolDatabase } from "./ordinaryCiPoolStoreSchema.js";

export type OrdinaryCiPoolAdmissionLease = {
  readonly now: () => number;
  readonly admissionLeaseMilliseconds: number;
};

export class OrdinaryCiPoolAdmissionStore {
  readonly #database: DatabaseSync;
  readonly #serviceId: string;
  readonly #lease: OrdinaryCiPoolAdmissionLease;

  constructor(file: string, serviceId: string, lease: OrdinaryCiPoolAdmissionLease) {
    this.#database = openOrdinaryCiPoolDatabase(file);
    this.#serviceId = serviceId;
    this.#lease = lease;
  }

  close(): void { this.#database.close(); }

  admit(input: OrdinaryCiPoolAdmissionInput): { readonly admission: OrdinaryCiPoolAdmission; readonly webhookToken: string } {
    const now = this.#lease.now();
    const expiresAt = now + this.#lease.admissionLeaseMilliseconds;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#parse(this.#database.prepare(
        "SELECT * FROM admissions WHERE project_id = ?"
      ).get(input.projectId));
      const refresh = existing !== undefined && existing.expiresAt > now
        && existing.serviceId === this.#serviceId
        && ordinaryCiPoolPolicyDigest(this.#serviceId, existing) === ordinaryCiPoolPolicyDigest(this.#serviceId, input);
      const admissionId = refresh ? existing.admissionId : randomBytes(32).toString("hex");
      const existingSecret = this.#database.prepare(
        "SELECT webhook_token FROM project_webhook_secrets WHERE project_id = ?"
      ).get(input.projectId);
      const webhookToken = parseSecret(existingSecret) ?? randomBytes(32).toString("hex");
      this.#database.prepare(`
        INSERT OR IGNORE INTO project_webhook_secrets(project_id, webhook_token) VALUES (?, ?)
      `).run(input.projectId, webhookToken);
      if (refresh) {
        this.#database.prepare("UPDATE admissions SET expires_at = ? WHERE admission_id = ?")
          .run(expiresAt, admissionId);
      } else {
        this.#database.prepare("DELETE FROM admissions WHERE project_id = ?").run(input.projectId);
        this.#database.prepare(`
          INSERT INTO admissions(
            admission_id, service_id, project_id, project_name, organization, organization_id,
            source_ref, source_commit, config_digest, job_image, runner_labels, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          admissionId, this.#serviceId, input.projectId, input.projectName, input.organization,
          input.organizationId, input.sourceRef, input.sourceCommit, input.configDigest, input.jobImage,
          JSON.stringify(input.runnerLabels), expiresAt
        );
      }
      this.#database.exec("COMMIT");
      return { admission: { admissionId, serviceId: this.#serviceId, ...input, expiresAt }, webhookToken };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  revoke(projectId: string, admissionId: string): boolean {
    return this.#database.prepare(
      "DELETE FROM admissions WHERE project_id = ? AND admission_id = ?"
    ).run(projectId, admissionId).changes === 1;
  }

  activeByProject(projectId: string): OrdinaryCiPoolAdmission | undefined {
    return this.#parse(this.#database.prepare(
      "SELECT * FROM admissions WHERE project_id = ? AND expires_at > ?"
    ).get(projectId, this.#lease.now()));
  }

  activeById(admissionId: string): OrdinaryCiPoolAdmission | undefined {
    return this.#parse(this.#database.prepare(
      "SELECT * FROM admissions WHERE admission_id = ? AND expires_at > ?"
    ).get(admissionId, this.#lease.now()));
  }

  activeIds(): readonly string[] {
    return this.#database.prepare("SELECT admission_id FROM admissions WHERE expires_at > ?")
      .all(this.#lease.now()).map((row) => parseAdmissionId(row));
  }

  webhookToken(projectId: string): string | undefined {
    return parseSecret(this.#database.prepare(`
      SELECT secrets.webhook_token FROM project_webhook_secrets secrets
      JOIN admissions ON admissions.project_id = secrets.project_id
      WHERE admissions.project_id = ? AND admissions.expires_at > ?
    `).get(projectId, this.#lease.now()));
  }

  #parse(value: unknown): OrdinaryCiPoolAdmission | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value) || typeof value.admission_id !== "string" || typeof value.service_id !== "string"
      || typeof value.project_id !== "string" || typeof value.project_name !== "string"
      || typeof value.organization !== "string" || !Number.isSafeInteger(value.organization_id)
      || typeof value.source_ref !== "string" || typeof value.source_commit !== "string"
      || typeof value.config_digest !== "string" || typeof value.job_image !== "string"
      || typeof value.runner_labels !== "string" || !Number.isSafeInteger(value.expires_at)) {
      throw new UserError("ordinary CI pool database contains an invalid admission");
    }
    const labels: unknown = JSON.parse(value.runner_labels);
    if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string")) {
      throw new UserError("ordinary CI pool database contains invalid admission labels");
    }
    return {
      admissionId: value.admission_id, serviceId: value.service_id, projectId: value.project_id,
      projectName: value.project_name, organization: value.organization, organizationId: Number(value.organization_id),
      sourceRef: value.source_ref, sourceCommit: value.source_commit, configDigest: value.config_digest,
      jobImage: value.job_image, runnerLabels: labels, expiresAt: Number(value.expires_at)
    };
  }
}

function parseSecret(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.webhook_token !== "string") throw new UserError("ordinary CI pool database contains an invalid webhook secret");
  return value.webhook_token;
}

function parseAdmissionId(value: unknown): string {
  if (!isRecord(value) || typeof value.admission_id !== "string") throw new UserError("ordinary CI pool database contains an invalid admission ID");
  return value.admission_id;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
