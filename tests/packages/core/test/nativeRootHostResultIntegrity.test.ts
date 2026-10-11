import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectNativeOrdinaryBundleState } from "../../../../core/packages/core/src/nativeOrdinaryBundleState.js";
import {
  hostAuthorization,
  post,
  reservationFixture,
  type ReservationFixture
} from "./nativeRootClaimReservationFixture.js";
import { activeAttempt, resultRequest } from "./nativeRootHostResultFixture.js";

const fixtures: ReservationFixture[] = [];

afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

describe("installed native ordinary host result integrity", () => {
  it.each([
    ["orphan pair", (database: DatabaseSync) => {
      database.exec("PRAGMA foreign_keys = OFF; DROP TRIGGER native_root_ci_host_results_no_update");
      const orphan = randomUUID();
      database.prepare("UPDATE native_root_ci_report_outbox SET claim_id = ?").run(orphan);
      database.prepare("UPDATE native_root_ci_host_results SET claim_id = ?, cleanup_resource_id = ?")
        .run(orphan, orphan);
    }],
    ["mismatched outbox", (database: DatabaseSync) => {
      database.prepare("UPDATE native_root_ci_report_outbox SET terminal_event_digest = ?")
        .run(`sha256:${"9".repeat(64)}`);
    }],
    ["tampered request", (database: DatabaseSync) => {
      database.exec("DROP TRIGGER native_root_ci_host_results_no_update");
      const row = requiredRow(database.prepare("SELECT request_json FROM native_root_ci_host_results").get());
      const request = JSON.parse(requiredText(row, "request_json"));
      request.terminalEvent.eventId = randomUUID();
      database.prepare("UPDATE native_root_ci_host_results SET request_json = ?").run(JSON.stringify(request));
    }],
    ["foreign cleanup resource", (database: DatabaseSync) => {
      database.exec("DROP TRIGGER native_root_ci_host_results_no_update");
      database.exec("PRAGMA ignore_check_constraints = ON");
      database.prepare("UPDATE native_root_ci_host_results SET cleanup_resource_id = ?").run(randomUUID());
      database.exec("PRAGMA ignore_check_constraints = OFF");
    }],
    ["wrong execution kind", (database: DatabaseSync) => {
      database.exec("DROP TRIGGER native_root_ci_host_results_no_update");
      const row = requiredRow(database.prepare("SELECT request_json FROM native_root_ci_host_results").get());
      const request = JSON.parse(requiredText(row, "request_json"));
      request.terminalEvent.payload.executionKind = "qemu";
      const eventJson = JSON.stringify(request.terminalEvent);
      const digest = `sha256:${createHash("sha256").update(eventJson).digest("hex")}`;
      database.prepare(`UPDATE native_root_ci_host_results SET request_json = ?, terminal_event_json = ?,
        terminal_event_digest = ?`).run(JSON.stringify(request), eventJson, digest);
      database.prepare(`UPDATE native_root_ci_report_outbox SET terminal_event_json = ?,
        terminal_event_digest = ?`).run(eventJson, digest);
    }],
    ["missing outbox", (database: DatabaseSync) => {
      database.exec("DELETE FROM native_root_ci_report_outbox");
    }],
    ["missing result", (database: DatabaseSync) => {
      database.exec(`PRAGMA foreign_keys = OFF;
        DROP TRIGGER native_root_ci_host_results_no_delete;
        DELETE FROM native_root_ci_host_results`);
    }],
    ["active claim with pending result", (database: DatabaseSync) => {
      database.prepare("UPDATE native_root_ci_claims SET state = 'active'").run();
    }],
    ["active receipt with pending result", (database: DatabaseSync) => {
      database.prepare("UPDATE native_root_ci_claim_receipts SET state = 'active'").run();
    }],
    ["active demand with pending result", (database: DatabaseSync) => {
      database.prepare("UPDATE native_root_ci_demands SET state = 'active'").run();
    }]
  ])("rejects a %s during check-state and startup without mutation", async (_label, corrupt) => {
    // Given
    const fixture = await reservationFixture(`installed-result-integrity-${String(_label).replaceAll(" ", "-")}`);
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "341");
    const request = resultRequest(active.claim, active.issuance, "541");
    expect((await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), request)).status).toBe(202);
    const database = new DatabaseSync(fixture.database);
    corrupt(database);
    database.close();
    const before = evidenceRows(fixture.database);

    // When / Then
    await expect(inspectNativeOrdinaryBundleState(dirname(fixture.database)))
      .rejects.toThrow(/receipt state is invalid|integrity check failed/i);
    expect(evidenceRows(fixture.database)).toEqual(before);
    await expect(fixture.restart()).rejects.toThrow(/receipt state is invalid|integrity check failed/i);
    expect(evidenceRows(fixture.database)).toEqual(before);
  }, 20_000);
});

function evidenceRows(file: string): unknown {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      results: database.prepare("SELECT * FROM native_root_ci_host_results").all(),
      outbox: database.prepare("SELECT * FROM native_root_ci_report_outbox").all(),
      demands: database.prepare("SELECT * FROM native_root_ci_demands").all(),
      claims: database.prepare("SELECT * FROM native_root_ci_claims").all(),
      receipts: database.prepare("SELECT * FROM native_root_ci_claim_receipts").all()
    };
  } finally {
    database.close();
  }
}

function requiredRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("row is missing");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

function requiredText(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`${key} is missing`);
  return value;
}
