import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/managed/src/nativeGitAdmissionHttpClient.js";
import type { NativeGitAdmissionHttpClient } from "../../../../core/packages/managed/src/nativeGitAdmissionSource.js";
import { createNativeRootCiHostClient, type NativeRootCiHostClient } from "../../../../core/packages/managed/src/nativeRootCiHostClient.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import {
  reservationFixture,
  type ReservationFixture
} from "./nativeRootClaimReservationFixture.js";

const fixtures: ReservationFixture[] = [];

afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

describe("native root CI host client", () => {
  it("reserves, issues, activates, and renews one exact format-11 claim", async () => {
    // Given
    const fixture = await reservationFixture("native-root-ci-host-client");
    fixtures.push(fixture);
    const client = hostClient(fixture);
    const signal = AbortSignal.timeout(10_000);

    // When
    await client.attest(signal);
    const claimRequest = client.prepareClaim(randomUUID());
    const claim = await client.reserve(claimRequest, signal);
    if (claim === undefined) throw new TypeError("expected queued native root CI claim");
    const issuance = await client.issue(claim, signal);
    const active = await client.activate(client.prepareActivation(claim, issuance, randomUUID()), signal);
    const renewed = await client.renew(client.prepareRenewal(active, randomUUID()), signal);

    // Then
    expect(claim.claimId).toBe(claim.issuanceRequestId);
    expect(issuance.descriptor.jobName).toBe(claim.event.jobName);
    expect(active.issuance).toEqual(issuance);
    expect(renewed.claimId).toBe(claim.claimId);
    expect(renewed.leaseDurationMilliseconds).toBeGreaterThan(0);
  }, 20_000);

  it("replays an exact reservation request and rejects changed request bytes", async () => {
    // Given
    const fixture = await reservationFixture("native-root-ci-host-client-replay");
    fixtures.push(fixture);
    const client = hostClient(fixture);
    const request = client.prepareClaim(randomUUID());

    // When
    const first = await client.reserve(request, AbortSignal.timeout(10_000));
    const replay = await client.reserve(request, AbortSignal.timeout(10_000));

    // Then
    expect(replay).toEqual(first);
    await expect(client.reserve({ ...request, body: request.body.replace("primary", "backup") },
      AbortSignal.timeout(10_000))).rejects.toThrow(/prepared.*inconsistent|outside configured capacity/i);
  }, 20_000);

  it("rejects an activation response that is not bound to the prepared request", async () => {
    // Given
    const fixture = await reservationFixture("native-root-ci-host-client-activation-binding");
    fixtures.push(fixture);
    const client = hostClient(fixture, corruptingClient("/v1/host-claim-activations"));
    const signal = AbortSignal.timeout(10_000);
    const claim = await client.reserve(client.prepareClaim(randomUUID()), signal);
    if (claim === undefined) throw new TypeError("expected queued native root CI claim");
    const issuance = await client.issue(claim, signal);

    // When
    const activation = client.activate(client.prepareActivation(claim, issuance, randomUUID()), signal);

    // Then
    await expect(activation).rejects.toThrow(/response.*inconsistent/);
  }, 20_000);

  it("rejects a renewal response that is not bound to the prepared lease identity", async () => {
    // Given
    const fixture = await reservationFixture("native-root-ci-host-client-renewal-binding");
    fixtures.push(fixture);
    const client = hostClient(fixture, corruptingClient("/v1/host-claim-renewals"));
    const signal = AbortSignal.timeout(10_000);
    const claim = await client.reserve(client.prepareClaim(randomUUID()), signal);
    if (claim === undefined) throw new TypeError("expected queued native root CI claim");
    const issuance = await client.issue(claim, signal);
    const active = await client.activate(client.prepareActivation(claim, issuance, randomUUID()), signal);

    // When
    const renewal = client.renew(client.prepareRenewal(active, randomUUID()), signal);

    // Then
    await expect(renewal).rejects.toThrow(/response.*inconsistent/);
  }, 20_000);
});

function hostClient(fixture: ReservationFixture, httpClient?: NativeGitAdmissionHttpClient): NativeRootCiHostClient {
  return createNativeRootCiHostClient({ hostId: "host-a", capacity: "primary", generationId,
    ordinaryCi: { endpoint: fixture.origin, serviceId: "ordinary-main",
      credential: { username: "host-a", password: bundleSecrets.host } },
    nativeGit: { endpoint: fixture.nativeOrigin, serviceId: "native-main" }
  }, httpClient);
}

function corruptingClient(path: string): NativeGitAdmissionHttpClient {
  const client = createNodeNativeGitAdmissionHttpClient();
  return { async request(input) {
    const response = await client.request(input);
    if (input.path !== path) return response;
    const body: unknown = JSON.parse(response.body.toString("utf8"));
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new TypeError("expected object response");
    return { ...response, body: Buffer.from(JSON.stringify({ ...body, requestId: randomUUID() })) };
  } };
}
