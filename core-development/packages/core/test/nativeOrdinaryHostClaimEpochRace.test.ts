import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeNativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import { parseReviewEnvelope } from "../../../../core/packages/native-git/src/review-event-schema.js";
import {
  nativeGitReviewFixture,
  readJsonObject,
  reviewPath,
  stringField,
  type ReviewFixture
} from "../../native-git/test/nativeGitReviewHarness.js";
import {
  jsonRecord,
  post,
  startAuthority,
  type AuthorityFixture
} from "./nativeOrdinaryAuthorityFixture.js";

const authorities: AuthorityFixture[] = [];
const nativeFixtures: ReviewFixture[] = [];

afterEach(async () => {
  await Promise.all(authorities.splice(0).map(async (fixture) => {
    await fixture.close();
    await fixture.remove();
  }));
  await Promise.all(nativeFixtures.splice(0).map((fixture) => fixture.close()));
});

describe("native ordinary host claim epoch race", () => {
  it("lets only the new epoch adopt a real native attempt without stale revocation", async () => {
    // Given
    const native = await nativeGitReviewFixture();
    nativeFixtures.push(native);
    const attemptIssuerPassword = "attempt-credential-secret-000000000000";
    const ordinaryCi = native.config.ordinaryCi;
    if (ordinaryCi === undefined) throw new Error("ordinary CI config is missing");
    await native.restart({
      ...native.config,
      ordinaryCi: {
        ...ordinaryCi,
        attemptIssuer: { username: "ordinary-attempts", password: attemptIssuerPassword }
      }
    });
    const reviewResponse = await native.request("reviewer-a-user", "POST", reviewPath(), {
      protectedRef: "refs/heads/main",
      proposalRef: native.proposalRef
    });
    const reviewId = stringField(await readJsonObject(reviewResponse), "reviewId");
    const envelope = parseReviewEnvelope(JSON.parse(await readFile(
      join(native.repositoryPath, "dim-reviews", "proposals", `${reviewId}.json`),
      "utf8"
    )));
    const event = envelope.events.find((candidate) => candidate.jobName === "source");
    if (event === undefined) throw new Error("source event is missing");
    const proofReached = deferred();
    const releaseOldProof = deferred();
    const transport = createNodeNativeGitAdmissionHttpClient();
    const currentHttpClient = {
      request: (input: Parameters<typeof transport.request>[0]) => transport.request({ ...input, endpoint: native.baseUrl() })
    };
    const staleHttpClient = {
      async request(input: Parameters<typeof transport.request>[0]) {
        const response = await currentHttpClient.request(input);
        if (input.path.endsWith("/ordinary-authority/current-attempt")) {
          proofReached.resolve();
          await releaseOldProof.promise;
        }
        return response;
      }
    };
    const stale = await startAuthority({
      nativeGitHttpClient: staleHttpClient,
      nativeGitAttemptIssuer: { username: "ordinary-attempts", password: attemptIssuerPassword }
    });
    authorities.push(stale);
    const policy = {
      schemaVersion: 1,
      projectId: "project-a",
      repositoryId: "source",
      protectedRef: "refs/heads/main",
      policyRevision: "policy-1",
      requiredReviewRevision: "review-1",
      requiredJobSetRevision: "jobs-1",
      requiredJobs: ["security", "source"]
    } as const;
    const admissionResponse = await post(stale.endpoint, "/v1/operator-admissions", "registrar", policy);
    const generation = (await jsonRecord(admissionResponse)).admissionGeneration;
    if (typeof generation !== "string") throw new Error("admission generation is missing");
    native.setAdmissionGeneration(generation);
    await post(stale.endpoint, "/v1/native-events", "webhook", event);
    const request = {
      schemaVersion: 1,
      requestId: "20000000-0000-4000-8000-000000000024",
      hostId: "host-a",
      capacity: "primary"
    } as const;
    const staleResponse = post(stale.endpoint, "/v1/host-claims", "host-a", request);
    await proofReached.promise;
    const current = await startAuthority({
      database: stale.database,
      nativeGitHttpClient: currentHttpClient,
      nativeGitAttemptIssuer: { username: "ordinary-attempts", password: attemptIssuerPassword }
    });
    authorities.push(current);

    // When
    const currentResponse = await post(current.endpoint, "/v1/host-claims", "host-a", request);
    releaseOldProof.resolve();
    const oldResponse = await staleResponse;

    // Then
    expect([oldResponse.status, currentResponse.status]).toEqual([503, 200]);
    const claim = await jsonRecord(currentResponse);
    const centralVerification = await post(current.endpoint, "/v1/current-attempt-verifications", "query", {
      schemaVersion: 1,
      requestId: "30000000-0000-4000-8000-000000000024",
      reviewId: claim.reviewId,
      attemptId: claim.attemptId,
      descriptorDigest: claim.descriptorDigest,
      admissionGeneration: claim.admissionGeneration,
      hostId: claim.hostId,
      capacity: claim.capacity
    });
    const nativeVerification = await native.request(
      "ordinary-identity",
      "POST",
      "/v1/projects/project-a/repositories/source/ordinary-authority/current-attempt",
      {
        schemaVersion: 1,
        requestId: "30000000-0000-4000-8000-000000000025",
        reviewId,
        jobName: "source",
        attemptId: claim.attemptId
      }
    );
    expect([centralVerification.status, nativeVerification.status]).toEqual([200, 200]);
    expect(await readdir(join(native.repositoryPath, "dim-reviews", "job-attempts", reviewId, "source"))).toEqual(["1.json"]);
    expect(await readdir(join(native.repositoryPath, "dim-reviews", "job-attempt-revocations"), { recursive: true })).toEqual([]);
    expect(assignmentCount(stale.database)).toBe(1);
  });
});

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

function assignmentCount(file: string): number {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return Number(database.prepare("SELECT count(*) total FROM native_attempt_assignments").get()?.total);
  } finally {
    database.close();
  }
}
