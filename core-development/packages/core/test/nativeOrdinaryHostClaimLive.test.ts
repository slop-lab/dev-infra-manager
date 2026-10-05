import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
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
  authorityHostCredentials,
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

describe("native ordinary host claim live integration", () => {
  it("issues exactly one real native attempt for concurrent two-capacity claims and replays the winner", async () => {
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
    expect(reviewResponse.status).toBe(201);
    const reviewId = stringField(await readJsonObject(reviewResponse), "reviewId");
    const envelope = parseReviewEnvelope(JSON.parse(await readFile(
      join(native.repositoryPath, "dim-reviews", "proposals", `${reviewId}.json`),
      "utf8"
    )));
    const event = envelope.events.find((candidate) => candidate.jobName === "source");
    if (event === undefined) throw new Error("source event is missing");
    const transport = createNodeNativeGitAdmissionHttpClient();
    const nativeHttpClient = {
      request: (input: Parameters<typeof transport.request>[0]) => transport.request({ ...input, endpoint: native.baseUrl() })
    };
    const authority = await startAuthority({
      nativeGitHttpClient: nativeHttpClient,
      nativeGitAttemptIssuer: {
        username: "ordinary-attempts",
        password: attemptIssuerPassword
      }
    });
    authorities.push(authority);
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
    const admissionResponse = await post(authority.endpoint, "/v1/operator-admissions", "registrar", policy);
    if (admissionResponse.status !== 200) throw new Error(await admissionResponse.text());
    const generation = (await jsonRecord(admissionResponse)).admissionGeneration;
    if (typeof generation !== "string") throw new Error("admission generation is missing");
    native.setAdmissionGeneration(generation);
    expect((await post(authority.endpoint, "/v1/native-events", "webhook", event)).status).toBe(202);
    const requests = [
      { schemaVersion: 1, requestId: "20000000-0000-4000-8000-000000000021", hostId: "host-a", capacity: "primary" },
      { schemaVersion: 1, requestId: "20000000-0000-4000-8000-000000000022", hostId: "host-b", capacity: "backup" }
    ] as const;

    // When
    const responses = await Promise.all([
      post(authority.endpoint, "/v1/host-claims", "host-a", requests[0]),
      post(authority.endpoint, "/v1/host-claims", "host-b", requests[1])
    ]);
    const winnerIndex = responses.findIndex((response) => response.status === 200);
    if (winnerIndex < 0) throw new Error("one host must win the claim");
    const winningRequest = requests.at(winnerIndex);
    if (winningRequest === undefined) throw new Error("winning request is missing");
    const winningRole = winningRequest.hostId;
    const winningResponse = responses.at(winnerIndex);
    if (winningResponse === undefined) throw new Error("winning response is missing");
    const firstClaim = await jsonRecord(winningResponse);
    const replay = await post(authority.endpoint, "/v1/host-claims", winningRole, winningRequest);

    // Then
    expect(responses.map((response) => response.status).sort()).toEqual([200, 204]);
    expect(replay.status).toBe(200);
    expect(await jsonRecord(replay)).toEqual(firstClaim);
    const attempt = JSON.parse(await readFile(
      join(native.repositoryPath, "dim-reviews", "job-attempts", reviewId, "source", "1.json"),
      "utf8"
    ));
    expect(attempt.issuanceRequestId).toBe(firstClaim.claimId);
    expect(firstClaim.admissionGeneration).toBe(generation);
    expect(JSON.stringify(firstClaim)).not.toMatch(/secret|password|token|credential/i);
    expect(await attemptFiles(native, reviewId)).toEqual(["1.json"]);
    expect((await native.git(native.repositoryPath, ["rev-parse", "refs/heads/main"])).stdout.trim()).toBe(native.protectedHead);
    expect(authorityHostCredentials[winningRole].username).toBe(firstClaim.hostId);
  });
});

async function attemptFiles(fixture: ReviewFixture, reviewId: string): Promise<readonly string[]> {
  return readdir(join(fixture.repositoryPath, "dim-reviews", "job-attempts", reviewId, "source"));
}
