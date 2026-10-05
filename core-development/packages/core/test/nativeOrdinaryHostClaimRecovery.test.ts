import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  NativeGitAttemptIssuerUnavailableError,
  type NativeGitAttemptIssuerClient
} from "../../../../core/packages/core/src/nativeGitAttemptIssuerClient.js";
import { nativeDescriptorDigest } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityModel.js";
import {
  admission,
  assignment,
  descriptor,
  jsonRecord,
  nativeEvent,
  post,
  startAuthority,
  type AuthorityFixture
} from "./nativeOrdinaryAuthorityFixture.js";

const fixtures: AuthorityFixture[] = [];

afterEach(async () => {
  const closing = fixtures.splice(0);
  await Promise.all(closing.map((fixture) => fixture.close()));
  await Promise.all(closing.map((fixture) => fixture.remove()));
});

describe("native ordinary host claim recovery", () => {
  it("replays one issuanceRequestId after native persistence and central response loss", async () => {
    // Given
    const issuanceIds: string[] = [];
    let loseResponse = true;
    let fixture: AuthorityFixture;
    const issuer = issuerClient({
      issued(input, authorize) {
        issuanceIds.push(input.issuanceRequestId);
        authorize();
        if (loseResponse) {
          loseResponse = false;
          throw new NativeGitAttemptIssuerUnavailableError();
        }
      }
    });
    fixture = await preparedFixture(issuer, (value) => fixture.source.authorizeAttempt(value));
    const request = claimRequest("20000000-0000-4000-8000-000000000011");

    // When
    const lost = await post(fixture.endpoint, "/v1/host-claims", "host-a", request);
    const restarted = await startAuthority({ database: fixture.database, attemptIssuerClient: issuer });
    fixtures.push(restarted);
    issuer.setAuthorize((value) => restarted.source.authorizeAttempt(value));
    const replay = await post(restarted.endpoint, "/v1/host-claims", "host-a", request);

    // Then
    expect(lost.status).toBe(503);
    expect(replay.status).toBe(200);
    const claim = await jsonRecord(replay);
    expect(issuanceIds).toEqual([claim.claimId, claim.claimId]);
    expect(states(restarted.database)).toEqual({ receipt: "active", demand: "claimed", claims: 1, assignments: 1 });
  });

  it("revokes and releases a receipt when G1 rotates before activation", async () => {
    // Given
    let loseResponse = true;
    let revoked = 0;
    let fixture: AuthorityFixture;
    const issuer = issuerClient({
      issued(_input, authorize) {
        authorize();
        if (loseResponse) {
          loseResponse = false;
          throw new NativeGitAttemptIssuerUnavailableError();
        }
      },
      revoked() {
        revoked += 1;
      }
    });
    fixture = await preparedFixture(issuer, (value) => fixture.source.authorizeAttempt(value));
    const request = claimRequest("20000000-0000-4000-8000-000000000012");
    expect((await post(fixture.endpoint, "/v1/host-claims", "host-a", request)).status).toBe(503);
    const rotated = admission("project-a", "source", "2");
    fixture.source.authorizePolicy(rotated);
    expect((await post(fixture.endpoint, "/v1/operator-admissions", "registrar", rotated)).status).toBe(200);

    // When
    const stale = await post(fixture.endpoint, "/v1/host-claims", "host-a", request);

    // Then
    expect(stale.status).toBe(409);
    expect(revoked).toBe(1);
    expect(states(fixture.database)).toEqual({ receipt: "released", demand: "superseded", claims: 0, assignments: 0 });
  });

  it("removes verifier visibility and fences an active capacity at a new service epoch", async () => {
    // Given
    let fixture: AuthorityFixture;
    const issuer = issuerClient({ issued(_input, authorize) { authorize(); } });
    fixture = await preparedFixture(issuer, (value) => fixture.source.authorizeAttempt(value));
    const request = claimRequest("20000000-0000-4000-8000-000000000013");
    const response = await post(fixture.endpoint, "/v1/host-claims", "host-a", request);
    const claim = await jsonRecord(response);
    await fixture.close();

    // When
    const restarted = await startAuthority({ database: fixture.database });
    fixtures.push(restarted);
    const verification = await post(restarted.endpoint, "/v1/current-attempt-verifications", "query", {
      schemaVersion: 1,
      requestId: "30000000-0000-4000-8000-000000000013",
      reviewId: claim.reviewId,
      attemptId: claim.attemptId,
      descriptorDigest: claim.descriptorDigest,
      admissionGeneration: claim.admissionGeneration,
      hostId: claim.hostId,
      capacity: claim.capacity
    });

    // Then
    expect(verification.status).toBe(404);
    expect(states(restarted.database)).toEqual({ receipt: "recovering", demand: "claimed", claims: 1, assignments: 0 });
    expect(fenceReason(restarted.database)).toBe("service-restart");
  });

  it("rejects a stale live server before receipt or native attempt mutation", async () => {
    // Given
    let staleAttempts = 0;
    let currentAttempts = 0;
    let stale: AuthorityFixture;
    const staleIssuer = issuerClient({
      issued(_input, authorize) {
        staleAttempts += 1;
        authorize();
      }
    });
    stale = await preparedFixture(staleIssuer, (value) => stale.source.authorizeAttempt(value));
    let current: AuthorityFixture;
    const currentIssuer = issuerClient({
      issued(_input, authorize) {
        currentAttempts += 1;
        authorize();
      }
    });
    current = await startAuthority({ database: stale.database, attemptIssuerClient: currentIssuer });
    fixtures.push(current);
    currentIssuer.setAuthorize((value) => current.source.authorizeAttempt(value));
    const request = claimRequest("20000000-0000-4000-8000-000000000015");

    // When
    const staleResponse = await post(stale.endpoint, "/v1/host-claims", "host-a", request);

    // Then
    expect(staleResponse.status).toBe(503);
    expect(staleAttempts).toBe(0);
    expect(currentAttempts).toBe(0);
    expect(states(stale.database)).toEqual({ receipt: undefined, demand: "queued", claims: 0, assignments: 0 });

    // When
    const currentResponse = await post(current.endpoint, "/v1/host-claims", "host-a", request);

    // Then
    expect(currentResponse.status).toBe(200);
    expect(staleAttempts).toBe(0);
    expect(currentAttempts).toBe(1);
    expect(states(stale.database)).toEqual({ receipt: "active", demand: "claimed", claims: 1, assignments: 1 });
  });

  it("revokes an in-flight native attempt when the service epoch rotates before activation", async () => {
    // Given
    const attemptStarted = deferred();
    const continueAttempt = deferred();
    let revoked = 0;
    let stale: AuthorityFixture;
    const staleIssuer = issuerClient({
      async issued(_input, authorize) {
        attemptStarted.resolve();
        await continueAttempt.promise;
        authorize();
      },
      revoked() {
        revoked += 1;
      }
    });
    stale = await preparedFixture(staleIssuer, (value) => stale.source.authorizeAttempt(value));
    const request = claimRequest("20000000-0000-4000-8000-000000000016");
    const pendingResponse = post(stale.endpoint, "/v1/host-claims", "host-a", request);
    await attemptStarted.promise;
    const current = await startAuthority({ database: stale.database });
    fixtures.push(current);

    // When
    continueAttempt.resolve();
    const response = await pendingResponse;

    // Then
    expect(response.status).toBe(409);
    expect(revoked).toBe(1);
    expect(states(stale.database)).toEqual({ receipt: "released", demand: "superseded", claims: 0, assignments: 0 });
  });

  it("removes verifier visibility and fences an active G1 claim on policy rotation", async () => {
    // Given
    let fixture: AuthorityFixture;
    const issuer = issuerClient({ issued(_input, authorize) { authorize(); } });
    fixture = await preparedFixture(issuer, (value) => fixture.source.authorizeAttempt(value));
    const request = claimRequest("20000000-0000-4000-8000-000000000014");
    const claimed = await post(fixture.endpoint, "/v1/host-claims", "host-a", request);
    expect(claimed.status).toBe(200);
    const rotated = admission("project-a", "source", "2");
    fixture.source.authorizePolicy(rotated);

    // When
    const rotation = await post(fixture.endpoint, "/v1/operator-admissions", "registrar", rotated);

    // Then
    expect(rotation.status).toBe(200);
    expect(states(fixture.database)).toEqual({ receipt: "recovering", demand: "claimed", claims: 1, assignments: 0 });
    expect(fenceReason(fixture.database)).toBe("generation-rotated");
  });
});

type IssuerHooks = {
  readonly issued: (input: { readonly issuanceRequestId: string }, authorize: () => void) => void | Promise<void>;
  readonly revoked?: () => void;
};
type ControllableIssuer = NativeGitAttemptIssuerClient & {
  readonly setAuthorize: (value: (attempt: ReturnType<typeof assignment>) => void) => void;
};

function issuerClient(hooks: IssuerHooks): ControllableIssuer {
  let authorizeAttempt: ((value: ReturnType<typeof assignment>) => void) | undefined;
  return {
    setAuthorize(value) { authorizeAttempt = value; },
    async loadDescriptor(context) {
      const value = descriptor(context.event.projectId, context.event.repositoryId, context.admissionGeneration);
      return { reviewId: context.event.reviewId, descriptor: value, digest: nativeDescriptorDigest(value) };
    },
    async issueAttempt(input) {
      const attemptId = "10000000-0000-4000-8000-000000000019";
      const value = assignment(input.descriptor.descriptor, input.context.event.reviewId, attemptId);
      await hooks.issued(input, () => authorizeAttempt?.(value));
      return {
        replayed: false,
        issuance: {
          schemaVersion: 2, issuanceRequestId: input.issuanceRequestId, attemptId,
          reviewId: input.context.event.reviewId, attempt: 1, descriptor: input.descriptor.descriptor,
          descriptorDigest: input.descriptor.digest, hostId: input.context.capacity.hostId,
          capacity: input.context.capacity.capacity, issuedBy: "ordinary-attempts", issuedAt: "2026-10-05T00:00:00.000Z"
        }
      };
    },
    async revokeAttempt(issuance) {
      hooks.revoked?.();
      return {
        schemaVersion: 2, revocationId: "40000000-0000-4000-8000-000000000019",
        attemptId: issuance.attemptId, reviewId: issuance.reviewId, jobName: issuance.descriptor.jobName,
        attempt: issuance.attempt, descriptorDigest: issuance.descriptorDigest, hostId: issuance.hostId,
        capacity: issuance.capacity, revokedBy: "ordinary-attempts", revokedAt: "2026-10-05T00:00:01.000Z"
      };
    }
  };
}

async function preparedFixture(
  issuer: ControllableIssuer,
  authorize: (value: ReturnType<typeof assignment>) => void
): Promise<AuthorityFixture> {
  issuer.setAuthorize(authorize);
  const fixture = await startAuthority({ attemptIssuerClient: issuer });
  fixtures.push(fixture);
  const policy = admission("project-a", "source", "1");
  fixture.source.authorizePolicy(policy);
  expect((await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy)).status).toBe(200);
  const event = nativeEvent();
  fixture.source.authorizeEvent(event);
  expect((await post(fixture.endpoint, "/v1/native-events", "webhook", event)).status).toBe(202);
  return fixture;
}

function claimRequest(requestId: string) {
  return { schemaVersion: 1, requestId, hostId: "host-a", capacity: "primary" } as const;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolver = resolve; });
  return {
    promise,
    resolve() {
      if (resolver === undefined) throw new TypeError("deferred resolver is unavailable");
      resolver();
    }
  };
}

function states(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const receipt = database.prepare("SELECT state FROM claim_receipts").get();
    const demand = database.prepare("SELECT state FROM demands").get();
    return {
      receipt: receipt?.state,
      demand: demand?.state,
      claims: Number(database.prepare("SELECT count(*) total FROM claims").get()?.total),
      assignments: Number(database.prepare("SELECT count(*) total FROM native_attempt_assignments").get()?.total)
    };
  } finally {
    database.close();
  }
}

function fenceReason(file: string): unknown {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare("SELECT reason FROM capacity_fences").get()?.reason;
  } finally {
    database.close();
  }
}
