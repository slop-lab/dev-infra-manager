import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/managed/src/nativeGitAdmissionHttpClient.js";
import {
  hostAuthorization,
  post,
  reservationFixture,
  type ReservationFixture
} from "./nativeRootClaimReservationFixture.js";
import { activeAttempt, resultRequest } from "./nativeRootHostResultFixture.js";

const fixtures: ReservationFixture[] = [];

afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

describe("installed native ordinary result activation fencing", () => {
  it("keeps reported capacity fenced when activation binding changes during status delivery", async () => {
    // Given
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    let statusReceived: (() => void) | undefined;
    const statusStarted = new Promise<void>((resolve) => { statusReceived = resolve; });
    const fixture = await reservationFixture("installed-result-activation-race", Date.now, (nativeOrigin) => {
      const transport = createNodeNativeGitAdmissionHttpClient();
      return { async request(input) {
        const response = await transport.request({ ...input, endpoint: nativeOrigin });
        if (input.path.endsWith("/statuses")) {
          statusReceived?.();
          await responseGate;
        }
        return response;
      } };
    });
    fixtures.push(fixture);
    const active = await activeAttempt(fixture, "303");
    const request = resultRequest(active.claim, active.issuance, "503");

    // When
    expect((await post(fixture.origin, "/v1/host-results", hostAuthorization("host-a"), request)).status).toBe(202);
    await statusStarted;
    const database = new DatabaseSync(fixture.database);
    const activation = database.prepare("SELECT activation_token_sha256 FROM bundle_activation").get();
    if (typeof activation?.activation_token_sha256 !== "string") throw new TypeError("activation binding is unavailable");
    database.prepare("UPDATE bundle_activation SET activation_token_sha256 = ?").run("9".repeat(64));
    database.close();
    releaseResponse?.();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Then
    expect(deliveryState(fixture.database)).toMatchObject({
      state: "pending", claim: "reported", receipt: "reported", demand: "reported"
    });
    const restored = new DatabaseSync(fixture.database);
    restored.prepare("UPDATE bundle_activation SET activation_token_sha256 = ?")
      .run(activation.activation_token_sha256);
    restored.close();
    await fixture.activate();
    await waitFor(() => deliveryState(fixture.database).state === "delivered");
    expect(deliveryState(fixture.database)).toMatchObject({
      state: "delivered", claim: "released", receipt: "released", demand: "completed"
    });
  }, 30_000);
});

function deliveryState(file: string): Readonly<Record<string, unknown>> {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      state: database.prepare("SELECT state FROM native_root_ci_report_outbox").get()?.state,
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
  throw new TypeError("condition was not observed");
}
