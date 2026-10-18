import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/managed/src/nativeGitAdmissionHttpClient.js";
import { inspectNativeOrdinaryBundleState } from "../../../../core/packages/managed/src/nativeOrdinaryBundleState.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import {
  hostAuthorization,
  post,
  queryAuthorization,
  reservationFixture,
  type ReservationFixture
} from "./nativeRootClaimReservationFixture.js";
import { activeAttempt, resultRequest } from "./nativeRootHostResultFixture.js";

const fixtures: ReservationFixture[] = [];

afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

describe("installed native ordinary current-terminal proof isolation", () => {
  it("proves the selected result despite large corrupt unrelated history while startup still rejects it", async () => {
    // Given
    const fixture = await reservationFixture("terminal-proof-isolated-history", Date.now, (nativeOrigin) => {
      const transport = createNodeNativeGitAdmissionHttpClient();
      return { request: (input) => transport.request({ ...input, endpoint: nativeOrigin }) };
    });
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "851");
    const result = resultRequest(active.claim, active.issuance, "951");
    expect((await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), result)).status).toBe(202);
    await waitFor(() => outboxState(fixture.database) === "delivered");
    insertCorruptOrphanHistory(fixture.database, 2_000);
    const before = selectedRows(fixture.database, active.claim.claimId);
    const startedAt = performance.now();

    // When
    const response = await fetch(`${fixture.origin}/v1/projects/project-a/repositories/root/`+
      "native-root-ci-result-proof/current-terminal", {
      method: "POST",
      headers: { authorization: queryAuthorization(), "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, requestId: randomUUID(), generationId,
        terminalEvent: result.terminalEvent })
    });

    // Then
    expect(response.status).toBe(200);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(terminalLookupPlan(fixture.database, result.terminalEvent.payload))
      .toContain("native_root_ci_host_results_terminal_selector");
    expect(selectedRows(fixture.database, active.claim.claimId)).toEqual(before);
    await expect(inspectNativeOrdinaryBundleState(dirname(fixture.database)))
      .rejects.toThrow(/receipt state is invalid|integrity check failed/i);
  }, 30_000);
});

function terminalLookupPlan(file: string, event: Readonly<Record<string, unknown>>): string {
  const attemptId = event.attemptId;
  const descriptorDigest = event.descriptorDigest;
  const hostId = event.hostId;
  if (typeof attemptId !== "string" || typeof descriptorDigest !== "string" || typeof hostId !== "string") {
    throw new TypeError("terminal lookup selector is invalid");
  }
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const row = database.prepare(`EXPLAIN QUERY PLAN SELECT claim_id FROM native_root_ci_host_results
      WHERE attempt_id = ? AND descriptor_digest = ? AND host_id = ?`).get(
      attemptId, descriptorDigest, hostId);
    return typeof row?.detail === "string" ? row.detail : "";
  } finally { database.close(); }
}

function insertCorruptOrphanHistory(file: string, count: number): void {
  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    const result = database.prepare(`INSERT INTO native_root_ci_host_results
      SELECT ?, host_id, ?, generation_id, attempt_id, descriptor_digest, '{}', terminal_event_json,
        terminal_event_digest, ?, cleanup_complete, created_at FROM native_root_ci_host_results LIMIT 1`);
    const outbox = database.prepare(`INSERT INTO native_root_ci_report_outbox
      SELECT ?, terminal_event_json, terminal_event_digest, state, acknowledgement_json,
        acknowledgement_digest, created_at, delivered_at FROM native_root_ci_report_outbox LIMIT 1`);
    for (let index = 0; index < count; index += 1) {
      const claimId = `orphan-${index}`;
      result.run(claimId, randomUUID(), claimId);
      outbox.run(claimId);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function selectedRows(file: string, claimId: string): unknown {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      result: database.prepare("SELECT * FROM native_root_ci_host_results WHERE claim_id = ?").get(claimId),
      outbox: database.prepare("SELECT * FROM native_root_ci_report_outbox WHERE claim_id = ?").get(claimId)
    };
  } finally { database.close(); }
}

function outboxState(file: string): string {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return String(database.prepare("SELECT state FROM native_root_ci_report_outbox").get()?.state); }
  finally { database.close(); }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not observed");
}
