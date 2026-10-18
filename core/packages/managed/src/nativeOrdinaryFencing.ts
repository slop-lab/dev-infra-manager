import type { DatabaseSync } from "node:sqlite";

export function fenceGenerationClaims(database: DatabaseSync, generation: string, now: number): void {
  database.prepare(`
    INSERT OR IGNORE INTO capacity_fences(host_id, capacity, claim_id, reason, created_at)
    SELECT host_id, capacity, claim_id, 'generation-rotated', ? FROM claims
    WHERE admission_generation = ? AND state = 'active'
  `).run(now, generation);
  database.prepare(`
    DELETE FROM native_attempt_assignments WHERE claim_id IN (
      SELECT claim_id FROM claims WHERE admission_generation = ? AND state = 'active'
    )
  `).run(generation);
  database.prepare(`
    UPDATE claim_receipts SET state = 'recovering', updated_at = ? WHERE claim_id IN (
      SELECT claim_id FROM claims WHERE admission_generation = ? AND state = 'active'
    )
  `).run(now, generation);
  database.prepare(`
    UPDATE claims SET state = 'recovering' WHERE admission_generation = ? AND state = 'active'
  `).run(generation);
}

export function fenceExpiredClaims(database: DatabaseSync, now: number): void {
  database.prepare(`
    INSERT OR IGNORE INTO capacity_fences(host_id, capacity, claim_id, reason, created_at)
    SELECT host_id, capacity, claim_id, 'lease-lost', ? FROM claims
    WHERE state = 'active' AND lease_expires_at <= ?
  `).run(now, now);
  database.prepare(`
    DELETE FROM native_attempt_assignments WHERE claim_id IN (
      SELECT claim_id FROM claims WHERE state = 'active' AND lease_expires_at <= ?
    )
  `).run(now);
  database.prepare(`
    UPDATE claim_receipts SET state = 'recovering', updated_at = ? WHERE claim_id IN (
      SELECT claim_id FROM claims WHERE state = 'active' AND lease_expires_at <= ?
    )
  `).run(now, now);
  database.prepare("UPDATE claims SET state = 'recovering' WHERE state = 'active' AND lease_expires_at <= ?").run(now);
}

export function fenceRestartedClaims(database: DatabaseSync, now: number): void {
  database.prepare(`
    INSERT OR IGNORE INTO capacity_fences(host_id, capacity, claim_id, reason, created_at)
    SELECT host_id, capacity, claim_id, 'service-restart', ? FROM claims WHERE state = 'active'
  `).run(now);
  database.prepare(`
    DELETE FROM native_attempt_assignments WHERE claim_id IN (
      SELECT claim_id FROM claims WHERE state = 'active'
    )
  `).run();
  database.prepare("UPDATE claims SET state = 'recovering' WHERE state = 'active'").run();
  database.prepare("UPDATE claim_receipts SET state = 'recovering', updated_at = ? WHERE state = 'active'")
    .run(now);
}
