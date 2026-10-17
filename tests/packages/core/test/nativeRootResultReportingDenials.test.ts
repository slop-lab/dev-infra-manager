import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionHttpClient.js";
import {
  claimRequest,
  hostAuthorization,
  post,
  reservationFixture,
  type ReservationFixture
} from "./nativeRootClaimReservationFixture.js";
import { activeAttempt, resultRequest } from "./nativeRootHostResultFixture.js";

const fixtures: ReservationFixture[] = [];

afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

describe("installed native ordinary result reporting denials", () => {
  it.each(["wrong credential", "mismatched acknowledgement", "foreign acknowledgement"] as const)(
    "keeps the outbox pending and capacity fenced after a %s",
    async (failure) => {
      // Given
      let statusRequests = 0;
      const fixture = await reservationFixture(`installed-result-${failure.replaceAll(" ", "-")}`, Date.now,
        (nativeOrigin) => {
          const transport = createNodeNativeGitAdmissionHttpClient();
          return { async request(input) {
            if (!input.path.endsWith("/statuses")) {
              return transport.request({ ...input, endpoint: nativeOrigin });
            }
            statusRequests += 1;
            const response = await transport.request({ ...input, endpoint: nativeOrigin,
              authorization: failure === "wrong credential" ? "Basic d3Jvbmc6d3Jvbmc=" : input.authorization });
            if (failure === "wrong credential") return response;
            const acknowledgement: unknown = JSON.parse(response.body.toString("utf8"));
            if (typeof acknowledgement !== "object" || acknowledgement === null || Array.isArray(acknowledgement)) {
              throw new TypeError("native status acknowledgement is missing");
            }
            return { ...response, body: Buffer.from(JSON.stringify({ ...acknowledgement,
              ...(failure === "mismatched acknowledgement"
                ? { eventId: randomUUID() } : { reporterUsername: "foreign-reporter" }) })) };
          } };
        });
      fixtures.push(fixture);
      const suffix = failure === "wrong credential" ? "303" : failure === "mismatched acknowledgement" ? "304" : "306";
      const active = await activeAttempt(fixture, suffix);
      const request = resultRequest(active.claim, active.issuance,
        failure === "wrong credential" ? "503" : failure === "mismatched acknowledgement" ? "504" : "506");

      // When
      expect((await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), request)).status).toBe(202);
      await waitFor(() => statusRequests > 0);
      const competing = await post(fixture.origin, "/v1/host-claims", hostAuthorization("host-a"),
        claimRequest(randomUUID(), "host-a", "primary"));

      // Then
      expect(reportState(fixture.database)).toEqual({ state: "pending", acknowledgement: null,
        claim: "reported", receipt: "reported", demand: "reported" });
      // A pending central acknowledgement withholds work but is not a fatal
      // host conflict: the same worker must continue idle polling.
      expect(competing.status).toBe(204);
    }, 30_000
  );

  it("accepts durable acknowledgement after the completed claim lease expires", async () => {
    // Given
    let now = 1_000;
    const statusCodes: number[] = [];
    const fixture = await reservationFixture("installed-result-expired-proof", () => now, (nativeOrigin) => {
      const transport = createNodeNativeGitAdmissionHttpClient();
      return { async request(input) {
        const response = await transport.request({ ...input, endpoint: nativeOrigin });
        if (input.path.endsWith("/statuses")) statusCodes.push(response.statusCode);
        return response;
      } };
    });
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "305");
    const request = resultRequest(active.claim, active.issuance, "505");

    // When
    expect((await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), request)).status).toBe(202);
    now = active.leaseExpiresAt + 1;
    await waitFor(() => statusCodes.length > 0);
    await waitFor(() => reportState(fixture.database).state === "delivered");

    // Then
    expect(statusCodes[0]).toBe(201);
    expect(reportState(fixture.database)).toMatchObject({ state: "delivered",
      claim: "released", receipt: "released", demand: "completed" });
  }, 30_000);

  it("keeps an exact native acknowledgement fenced when the admission becomes stale before local commit", async () => {
    // Given
    let databaseFile = "";
    let statusRequests = 0;
    const fixture = await reservationFixture("installed-result-stale-admission-ack", Date.now, (nativeOrigin) => {
      const transport = createNodeNativeGitAdmissionHttpClient();
      return { async request(input) {
        const response = await transport.request({ ...input, endpoint: nativeOrigin });
        if (input.path.endsWith("/statuses")) {
          statusRequests += 1;
          const database = new DatabaseSync(databaseFile);
          database.prepare("UPDATE native_root_admissions SET state = 'revoked'").run();
          database.close();
        }
        return response;
      } };
    });
    fixtures.push(fixture);
    databaseFile = fixture.database;
    const active = await activeAttempt(fixture, "307");
    const request = resultRequest(active.claim, active.issuance, "507");

    // When
    expect((await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), request)).status).toBe(202);
    await waitFor(() => statusRequests > 0);

    // Then
    expect(reportState(fixture.database)).toEqual({ state: "pending", acknowledgement: null,
      claim: "reported", receipt: "reported", demand: "reported" });
  }, 30_000);
});

function reportState(file: string): Readonly<Record<string, unknown>> {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const outbox = database.prepare("SELECT state, acknowledgement_json FROM native_root_ci_report_outbox").get();
    return {
      state: outbox?.state,
      acknowledgement: outbox?.acknowledgement_json,
      claim: database.prepare("SELECT state FROM native_root_ci_claims").get()?.state,
      receipt: database.prepare("SELECT state FROM native_root_ci_claim_receipts").get()?.state,
      demand: database.prepare("SELECT state FROM native_root_ci_demands").get()?.state
    };
  } finally {
    database.close();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not observed");
}
