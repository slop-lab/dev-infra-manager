import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { assertNativeRootCiEventReceiptIntegrity } from "../../../../core/packages/core/src/nativeRootCiEventReceiptIntegrity.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import {
  claimRequest,
  hostAuthorization,
  post,
  queryAuthorization,
  registrarAuthorization,
  reservationFixture,
  rows,
  type ReservationFixture,
  verificationRequest
} from "./nativeRootClaimReservationFixture.js";

const fixtures: ReservationFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("installed native root claim reservations", () => {
  it("reserves one demand across two capacities and verifies only its exact authoritative envelope", async () => {
    // Given
    const fixture = await reservationFixture("installed-claim-race");
    fixtures.push(fixture);
    const hostA = claimRequest("20000000-0000-4000-8000-000000000001", "host-a", "primary");
    const hostB = claimRequest("20000000-0000-4000-8000-000000000002", "host-b", "backup");
    const identity = await get(fixture.origin, "/v1/host-identity", hostAuthorization("host-a"));

    // When
    const raced = await Promise.all([
      post(fixture.origin, "/v1/host-claims", hostAuthorization("host-a"), hostA),
      post(fixture.origin, "/v1/host-claims", hostAuthorization("host-b"), hostB)
    ]);
    const winner = raced.find(({ status }) => status === 201);
    if (winner === undefined) throw new TypeError("claim race has no winner");
    const exact = await post(fixture.origin, "/v1/claim-reservation-verifications", queryAuthorization(),
      verificationRequest(winner.body));
    const claim = record(winner.body);
    const wrongImage = await verifyChanged(fixture, claim, { runnerBaseImage: `registry.example/evil@sha256:${"9".repeat(64)}` });
    const wrongBounds = await verifyChanged(fixture, claim, { bounds: { ...record(claim.bounds), cpu: "5" } });
    const wrongGeneration = await post(fixture.origin, "/v1/claim-reservation-verifications", queryAuthorization(), {
      ...verificationRequest(winner.body), generationId: "f".repeat(64)
    });
    const foreignHost = await post(fixture.origin, "/v1/host-claims", hostAuthorization("host-a"), hostB);
    const wrongRole = await post(fixture.origin, "/v1/host-claims", queryAuthorization(), hostA);
    const unknown = await post(fixture.origin, "/v1/host-claims", "Basic dW5rbm93bjp1bmtub3du", hostA);

    // Then
    expect(identity).toEqual({ status: 200, body: {
      schemaVersion: 1,
      serviceId: "ordinary-main",
      role: "native-host",
      hostId: "host-a"
    } });
    expect(raced.map(({ status }) => status).sort()).toEqual([201, 204]);
    expect(claim.issuanceRequestId).toBe(claim.claimId);
    expect(claim.event).toEqual(fixture.event);
    expect(claim.admissionGeneration).toBe(fixture.admissionGeneration);
    expect(claim.runnerBaseImage).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(claim.jobBaseImage).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(exact.status).toBe(200);
    expect(record(exact.body).authorized).toBe(true);
    expect([wrongImage.status, wrongBounds.status, wrongGeneration.status]).toEqual([404, 404, 409]);
    expect([foreignHost.status, wrongRole.status, unknown.status]).toEqual([404, 403, 401]);
    expect(rows(fixture.database)).toMatchObject({
      epochs: [{ generation_id: generationId, active: 1 }],
      demands: [{ state: "preparing" }],
      claims: [{ claim_id: claim.claimId, issuance_request_id: claim.claimId, state: "preparing" }]
    });
  });

  it("rejects malformed reservation and verification bodies at the HTTP boundary", async () => {
    // Given
    const fixture = await reservationFixture("installed-claim-malformed");
    fixtures.push(fixture);

    // When
    const malformedClaim = await post(fixture.origin, "/v1/host-claims", hostAuthorization("host-a"), {
      ...claimRequest("20000000-0000-4000-8000-000000000005", "host-a", "primary"),
      candidateImage: "candidate-controlled"
    });
    const malformedVerification = await post(fixture.origin, "/v1/claim-reservation-verifications",
      queryAuthorization(), { schemaVersion: 1 });

    // Then
    expect([malformedClaim.status, malformedVerification.status]).toEqual([400, 400]);
    expect(rows(fixture.database)).toMatchObject({ demands: [{ state: "queued" }], claims: [] });
  });

  it("rejects a persisted claim whose response diverges from its receipt", async () => {
    // Given
    const fixture = await reservationFixture("installed-claim-integrity");
    fixtures.push(fixture);
    const reserved = await post(fixture.origin, "/v1/host-claims", hostAuthorization("host-a"),
      claimRequest("20000000-0000-4000-8000-000000000006", "host-a", "primary"));
    expect(reserved.status).toBe(201);
    const database = new DatabaseSync(fixture.database);
    const changed = { ...record(reserved.body), eventDigest: `sha256:${"0".repeat(64)}` };
    database.prepare("UPDATE native_root_ci_claims SET response_json = ?").run(JSON.stringify(changed));
    database.close();

    // When / Then
    expect(() => assertNativeRootCiEventReceiptIntegrity(fixture.database)).toThrow(/receipt state is invalid/i);
  });

  it("rejects verification after expiry, root rotation, and revocation", async () => {
    // Given
    const fixture = await reservationFixture("installed-claim-invalidation");
    fixtures.push(fixture);
    const request = claimRequest("20000000-0000-4000-8000-000000000003", "host-a", "primary");
    const reserved = await post(fixture.origin, "/v1/host-claims", hostAuthorization("host-a"), request);
    expect(reserved.status).toBe(201);
    const database = new DatabaseSync(fixture.database);
    const admission = database.prepare(`SELECT lease_expires_at, root_sequence, root_commit, root_tree
      FROM native_root_admissions WHERE admission_generation = ?`).get(fixture.admissionGeneration);
    if (admission === undefined) throw new TypeError("admission row is missing");
    const leaseExpiresAt = numberValue(admission.lease_expires_at);
    const rootSequence = numberValue(admission.root_sequence);
    const rootCommit = stringValue(admission.root_commit);
    const rootTree = stringValue(admission.root_tree);

    // When
    database.prepare("UPDATE native_root_admissions SET lease_expires_at = 1 WHERE admission_generation = ?")
      .run(fixture.admissionGeneration);
    const expired = await verify(fixture, reserved.body);
    database.prepare(`UPDATE native_root_admissions SET lease_expires_at = ?, root_sequence = root_sequence + 1,
      root_commit = ?, root_tree = ? WHERE admission_generation = ?`).run(
      leaseExpiresAt, "6".repeat(40), "7".repeat(40), fixture.admissionGeneration);
    const rotated = await verify(fixture, reserved.body);
    database.prepare(`UPDATE native_root_admissions SET root_sequence = ?, root_commit = ?, root_tree = ?
      WHERE admission_generation = ?`).run(rootSequence, rootCommit, rootTree, fixture.admissionGeneration);
    database.close();
    const revoked = await post(fixture.origin,
      "/v1/projects/project-a/repositories/root/native-root-admission/revoke", registrarAuthorization(), {
        schemaVersion: 1,
        requestId: randomUUID(),
        generationId,
        admissionGeneration: fixture.admissionGeneration
      });
    const afterRevocation = await verify(fixture, reserved.body);

    // Then
    expect([expired.status, rotated.status, revoked.status, afterRevocation.status]).toEqual([404, 404, 200, 404]);
  });

  it("replays one historical claim after restart but rejects its old service epoch", async () => {
    // Given
    const fixture = await reservationFixture("installed-claim-restart");
    fixtures.push(fixture);
    const request = claimRequest("20000000-0000-4000-8000-000000000004", "host-a", "primary");
    const reserved = await post(fixture.origin, "/v1/host-claims", hostAuthorization("host-a"), request);
    expect(reserved.status).toBe(201);
    const before = rows(fixture.database);
    const restarted = await fixture.restart();
    fixtures.push(restarted);

    // When
    const replay = await post(restarted.origin, "/v1/host-claims", hostAuthorization("host-a"), request);
    const stale = await verify(restarted, reserved.body);
    const after = rows(restarted.database);

    // Then
    expect(replay).toEqual({ status: 200, body: reserved.body });
    expect(stale.status).toBe(409);
    expect(arrayField(before, "claims")).toHaveLength(1);
    expect(arrayField(after, "claims")).toHaveLength(1);
    expect(arrayField(after, "epochs")).toHaveLength(2);
    expect(record(arrayField(after, "claims")[0]).service_epoch_id).toBe(record(reserved.body).serviceEpochId);
  });
});

function verify(fixture: ReservationFixture, claim: unknown) {
  return post(fixture.origin, "/v1/claim-reservation-verifications", queryAuthorization(), verificationRequest(claim));
}
async function get(origin: string, path: string, authorization: string) {
  const response = await fetch(`${origin}${path}`, { headers: { authorization } });
  return { status: response.status, body: await response.json() };
}
function verifyChanged(fixture: ReservationFixture, claim: Readonly<Record<string, unknown>>,
  changed: Readonly<Record<string, unknown>>) {
  return verify(fixture, { ...claim, ...changed });
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("record is invalid");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}
function arrayField(value: unknown, field: string): readonly unknown[] {
  const candidate = record(value)[field];
  if (!Array.isArray(candidate)) throw new TypeError("array field is invalid");
  return candidate;
}
function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("string value is invalid");
  return value;
}
function numberValue(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("number value is invalid");
  return value;
}
