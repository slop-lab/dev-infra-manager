import type { DatabaseSync } from "node:sqlite";

export class NativeRootCiDemandStore {
  constructor(readonly database: DatabaseSync) {}

  supersedeGeneration(admissionGeneration: string, now: number): void {
    this.database.prepare(`UPDATE native_root_ci_demands SET state = 'superseded', updated_at = ?, terminal_at = ?
      WHERE admission_generation = ? AND state = 'queued'`).run(now, now, admissionGeneration);
  }

  supersedeExpired(now: number): void {
    this.database.prepare(`UPDATE native_root_ci_demands SET state = 'superseded', updated_at = ?, terminal_at = ?
      WHERE state = 'queued' AND admission_generation IN (SELECT admission_generation FROM native_root_admissions
        WHERE state = 'active' AND lease_expires_at <= ?)`).run(now, now, now);
  }

  supersedeRotated(input: {
    readonly controlPlaneGenerationId: string;
    readonly capacityConfigDigest: string;
    readonly now: number;
  }): void {
    this.database.prepare(`UPDATE native_root_ci_demands SET state = 'superseded', updated_at = ?, terminal_at = ?
      WHERE state = 'queued' AND admission_generation IN (SELECT admission_generation FROM native_root_admissions
        WHERE state = 'active' AND (control_plane_generation_id <> ? OR capacity_config_digest <> ?))`)
      .run(input.now, input.now, input.controlPlaneGenerationId, input.capacityConfigDigest);
  }
}
