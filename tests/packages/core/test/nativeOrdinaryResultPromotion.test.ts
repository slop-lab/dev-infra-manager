import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { promote, protectedHead } from "../../native-git/test/nativeGitPromotionHarness.js";
import { stringField } from "../../native-git/test/nativeGitReviewHarness.js";
import { admission, jsonRecord, post, type AuthorityFixture } from "./nativeOrdinaryAuthorityFixture.js";
import {
  nativeOrdinaryPromotionFixture,
  type NativeOrdinaryPromotionFixture
} from "./nativeOrdinaryPromotionFixture.js";

const systems: NativeOrdinaryPromotionFixture[] = [];

afterEach(async () => {
  await Promise.all(systems.splice(0).map(async (system) => {
    await system.authority.close();
    await system.native.close();
    await system.authority.remove();
  }));
});

describe("native ordinary result promotion authority", () => {
  it("denies both required G1 results after G2 admission and leaves the protected ref unchanged", async () => {
    // Given
    const system = await nativeOrdinaryPromotionFixture("paused");
    systems.push(system);
    await acceptEvents(system);
    const source = await claim(system.authority, { hostId: "host-a", capacity: "primary", suffix: "81" });
    const security = await claim(system.authority, { hostId: "host-b", capacity: "backup", suffix: "82" });
    expect((await postResult(system.authority, { hostId: "host-a", claim: source, suffix: "81" })).status).toBe(202);
    expect((await postResult(system.authority, { hostId: "host-b", claim: security, suffix: "82" })).status).toBe(202);
    const before = await protectedHead(system.native);

    // When
    const revoked = await post(system.authority.endpoint, "/v1/operator-admission-revocations", "registrar", {
      schemaVersion: 1,
      projectId: "project-a",
      repositoryId: "source",
      admissionGeneration: system.admissionGeneration
    });
    const policy = admission("project-a", "source", "1");
    const admitted = await post(system.authority.endpoint, "/v1/operator-admissions", "registrar", {
      ...policy,
      requiredJobs: ["security", "source"]
    });
    const generation2 = (await jsonRecord(admitted)).admissionGeneration;
    const sourceVerification = await verify(system.authority, source, "81");
    const securityVerification = await verify(system.authority, security, "82");
    const promotion = await promote(system.native, system.review);

    // Then
    expect(revoked.status).toBe(204);
    expect(admitted.status).toBe(200);
    expect(generation2).not.toBe(system.admissionGeneration);
    expect([sourceVerification.status, securityVerification.status]).toEqual([404, 404]);
    expect(promotion.status).toBe(409);
    expect(await protectedHead(system.native)).toBe(before);
    expect(resultStates(system.authority.database)).toEqual([
      { outbox: "denied", denial: "admission-inactive", demand: "failed", claim: "released" },
      { outbox: "denied", denial: "admission-inactive", demand: "failed", claim: "released" }
    ]);
  });

  it("keeps a native status non-promotable when its lost acknowledgement is followed by reporter denial", async () => {
    // Given
    const system = await nativeOrdinaryPromotionFixture("lose-first-status-response");
    systems.push(system);
    await acceptEvents(system);
    const source = await claim(system.authority, { hostId: "host-a", capacity: "primary", suffix: "91" });
    expect((await postResult(system.authority, { hostId: "host-a", claim: source, suffix: "91" })).status).toBe(202);
    await waitFor(() => system.lostStatusResponse());
    await system.rejectReporter();
    await waitFor(() => resultStates(system.authority.database)[0]?.outbox === "denied");
    await system.restoreReporter();
    const security = await claim(system.authority, { hostId: "host-a", capacity: "primary", suffix: "92" });
    expect((await postResult(system.authority, { hostId: "host-a", claim: security, suffix: "92" })).status).toBe(202);
    await waitFor(() => resultStates(system.authority.database).some((state) => state.demand === "completed"));
    const before = await protectedHead(system.native);

    // When
    const sourceVerification = await verify(system.authority, source, "91");
    const promotion = await promote(system.native, system.review);
    const reviewId = stringField(system.review, "reviewId");
    const sourceStatus = JSON.parse(await readFile(join(
      system.native.repositoryPath, "dim-reviews", "statuses", reviewId, "source", "1.json"
    ), "utf8"));
    const securityStatus = JSON.parse(await readFile(join(
      system.native.repositoryPath, "dim-reviews", "statuses", reviewId, "security", "1.json"
    ), "utf8"));

    // Then
    expect(sourceVerification.status).toBe(404);
    expect(sourceStatus.payload.result).toBe("success");
    expect(securityStatus.payload.result).toBe("success");
    expect(resultStates(system.authority.database)).toContainEqual({
      outbox: "denied",
      denial: "native-denied",
      demand: "failed",
      claim: "released"
    });
    expect(promotion.status).toBe(500);
    expect(await protectedHead(system.native)).toBe(before);
  });
});

async function acceptEvents(system: NativeOrdinaryPromotionFixture): Promise<void> {
  for (const event of system.events) {
    expect((await post(system.authority.endpoint, "/v1/native-events", "webhook", event)).status).toBe(202);
  }
}

type ClaimInput = {
  readonly hostId: "host-a" | "host-b";
  readonly capacity: "primary" | "backup";
  readonly suffix: string;
};

async function claim(authority: AuthorityFixture, input: ClaimInput) {
  const response = await post(authority.endpoint, "/v1/host-claims", input.hostId, {
    schemaVersion: 1,
    requestId: `20000000-0000-4000-8000-0000000000${input.suffix}`,
    hostId: input.hostId,
    capacity: input.capacity
  });
  expect(response.status).toBe(200);
  return jsonRecord(response);
}

type ResultInput = {
  readonly hostId: "host-a" | "host-b";
  readonly claim: Readonly<Record<string, unknown>>;
  readonly suffix: string;
};

function postResult(authority: AuthorityFixture, input: ResultInput) {
  const now = "2026-10-05T00:00:00.000Z";
  return post(authority.endpoint, "/v1/host-results", input.hostId, {
    schemaVersion: 1,
    requestId: `50000000-0000-4000-8000-0000000000${input.suffix}`,
    claimId: input.claim.claimId,
    terminalEvent: {
      schemaVersion: 2,
      eventId: `60000000-0000-4000-8000-0000000000${input.suffix}`,
      occurredAt: now,
      eventType: "dim.ci.job.completed",
      payload: {
        reviewId: input.claim.reviewId,
        attemptId: input.claim.attemptId,
        attempt: 1,
        descriptor: input.claim.descriptor,
        descriptorDigest: input.claim.descriptorDigest,
        hostId: input.claim.hostId,
        capacity: input.claim.capacity,
        startedAt: now,
        finishedAt: now,
        result: "success",
        completion: { kind: "exited", exitCode: 0 },
        stdout: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false },
        stderr: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false }
      }
    },
    cleanupComplete: true
  });
}

function verify(authority: AuthorityFixture, claimValue: Readonly<Record<string, unknown>>, suffix: string): Promise<Response> {
  return post(authority.endpoint, "/v1/current-attempt-verifications", "query", {
    schemaVersion: 1,
    requestId: `30000000-0000-4000-8000-0000000000${suffix}`,
    reviewId: claimValue.reviewId,
    attemptId: claimValue.attemptId,
    descriptorDigest: claimValue.descriptorDigest,
    admissionGeneration: claimValue.admissionGeneration,
    hostId: claimValue.hostId,
    capacity: claimValue.capacity
  });
}

function resultStates(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare(`
      SELECT outbox.state outbox, outbox.denial_code denial, demands.state demand, claims.state claim
      FROM report_outbox outbox JOIN claims ON claims.claim_id = outbox.claim_id
      JOIN demands ON demands.demand_id = claims.demand_id ORDER BY demands.job_name
    `).all();
  } finally {
    database.close();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not observed");
}
