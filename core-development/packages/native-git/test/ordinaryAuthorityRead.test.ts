import { readdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApprovedReview,
  issueJob,
  revokeJobAttempt
} from "./nativeGitPromotionHarness.js";
import {
  nativeGitReviewFixture,
  objectField,
  readJsonObject,
  stringField,
  type ReviewFixture
} from "./nativeGitReviewHarness.js";

const fixtures: ReviewFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("native Git ordinary authority reads", () => {
  it("returns its pinned proof identity and canonical protected policy only to the ordinary identity", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const identity = await fixture.request("ordinary-identity", "GET", "/v1/ordinary-authority/identity");
    const policy = await proofRequest(fixture, "policy", {
      schemaVersion: 1,
      requestId: "00000000-0000-4000-8000-000000000001",
      protectedRef: "refs/heads/main"
    });

    // Then
    expect(identity.status).toBe(200);
    expect(await readJsonObject(identity)).toEqual({
      schemaVersion: 1,
      serviceId: "native-main",
      role: "ordinary-authority-reader",
      scope: ["policy:read", "review-event:read", "attempt:read"]
    });
    expect(policy.status).toBe(200);
    expect(policy.headers.get("cache-control")).toBe("no-store");
    expect(await readJsonObject(policy)).toEqual({
      schemaVersion: 1,
      serviceId: "native-main",
      requestId: "00000000-0000-4000-8000-000000000001",
      policy: {
        schemaVersion: 1,
        projectId: "project-a",
        repositoryId: "source",
        protectedRef: "refs/heads/main",
        policyRevision: "policy-1",
        requiredReviewRevision: "review-1",
        requiredJobSetRevision: "jobs-1",
        requiredJobs: ["security", "source"]
      }
    });
  });

  it("returns the exact current unrevoked schema-2 issuance without mutating its record", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createApprovedReview(fixture);
    const issuance = await issueJob(fixture, review, "source");
    const reviewId = stringField(review, "reviewId");
    const attemptPath = `${fixture.repositoryPath}/dim-reviews/job-attempts/${reviewId}/source/1.json`;
    const before = await readFile(attemptPath);
    await fixture.restart();

    // When
    const response = await currentAttemptRequest(fixture, reviewId, "source", stringField(issuance, "attemptId"));

    // Then
    expect(response.status).toBe(200);
    const result = await readJsonObject(response);
    expect(result).toEqual({
      schemaVersion: 1,
      serviceId: "native-main",
      requestId: "00000000-0000-4000-8000-000000000002",
      assignment: {
        schemaVersion: 1,
        reviewId,
        attemptId: stringField(issuance, "attemptId"),
        descriptor: objectField(issuance, "descriptor"),
        descriptorDigest: stringField(issuance, "descriptorDigest"),
        admissionGeneration: "generation-7",
        hostId: "host-a",
        capacity: "primary"
      }
    });
    expect(await readFile(attemptPath)).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(/identity-credential|source verified|patchBytes|issuedBy|issuanceRequestId|issuedAt/);
  });

  it("denies unissued, replaced, revoked, foreign, and policy-drifted attempts", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createApprovedReview(fixture);
    const first = await issueJob(fixture, review, "source");
    const reviewId = stringField(review, "reviewId");
    const unissued = currentAttemptRequest(fixture, reviewId, "source", "00000000-0000-4000-8000-000000000099");
    const foreign = fixture.request("ordinary-identity", "POST", "/v1/projects/project-b/repositories/source/ordinary-authority/current-attempt", {
      schemaVersion: 1,
      requestId: "00000000-0000-4000-8000-000000000002",
      reviewId,
      jobName: "source",
      attemptId: stringField(first, "attemptId")
    });
    const replacement = await issueJob(fixture, review, "source");

    // When
    const replaced = await currentAttemptRequest(fixture, reviewId, "source", stringField(first, "attemptId"));
    const revokedResponse = await revokeJobAttempt(fixture, review, "source", replacement);
    const revoked = await currentAttemptRequest(fixture, reviewId, "source", stringField(replacement, "attemptId"));
    const current = await issueJob(fixture, review, "source");
    await fixture.restart(fixture.configWithPolicyRevision("policy-2"));
    const drifted = await currentAttemptRequest(fixture, reviewId, "source", stringField(current, "attemptId"));

    // Then
    expect((await unissued).status).toBe(404);
    expect((await foreign).status).toBe(404);
    expect(replaced.status).toBe(404);
    expect(revokedResponse.status).toBe(201);
    expect(revoked.status).toBe(404);
    expect(drifted.status).toBe(404);
  });

  it("serializes a current-attempt proof with concurrent revocation", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createApprovedReview(fixture);
    const issuance = await issueJob(fixture, review, "source");
    const reviewId = stringField(review, "reviewId");

    // When
    const [proof, revocation] = await Promise.all([
      currentAttemptRequest(fixture, reviewId, "source", stringField(issuance, "attemptId")),
      revokeJobAttempt(fixture, review, "source", issuance)
    ]);
    const after = await currentAttemptRequest(fixture, reviewId, "source", stringField(issuance, "attemptId"));

    // Then
    expect([200, 404]).toContain(proof.status);
    expect(revocation.status).toBe(201);
    expect(after.status).toBe(404);
  });

  it("denies an issued attempt after its reviewed proposal becomes obsolete", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createApprovedReview(fixture);
    const issuance = await issueJob(fixture, review, "source");
    await writeFile(`${fixture.clone}/late-change.txt`, "late change\n");
    await fixture.git(fixture.clone, ["add", "late-change.txt"]);
    await fixture.git(fixture.clone, ["commit", "-m", "move proposal"]);
    await fixture.git(fixture.clone, ["push", "origin", `HEAD:${fixture.proposalRef}`]);

    // When
    const response = await currentAttemptRequest(
      fixture,
      stringField(review, "reviewId"),
      "source",
      stringField(issuance, "attemptId")
    );

    // Then
    expect(response.status).toBe(404);
  });

  it("rejects generic native roles, non-exact routes, and oversized bodies without changing evidence", async () => {
    // Given
    const fixture = await startFixture();
    const evidenceBefore = await readdir(`${fixture.repositoryPath}/dim-reviews/job-attempts`);
    const roles = [
      "admin-a", "ci-a", "native-main", "ordinary-attempts", "ordinary-results", "promoter-a",
      "reviewer-a-user", "scheduler-a", "source-ci", "writer-a"
    ];

    // When
    const denied = await Promise.all(roles.map((identity) => fixture.request(
      identity,
      "GET",
      "/v1/ordinary-authority/identity"
    )));
    const query = await fixture.request("ordinary-identity", "GET", "/v1/ordinary-authority/identity?all=true");
    const wrongMethod = await fixture.request("ordinary-identity", "GET", "/v1/projects/project-a/repositories/source/ordinary-authority/policy");
    const selector = await proofRequest(fixture, "policy", {
      schemaVersion: 1,
      requestId: "00000000-0000-4000-8000-000000000001",
      protectedRef: "refs/heads/main",
      requiredJobs: ["source"],
      hostId: "host-a",
      capacity: "primary"
    });
    const genericIdentity = await fixture.request("ordinary-identity", "GET", "/v1/identity");
    const reviewId = "a".repeat(64);
    const forbiddenOperations = await Promise.all([
      { method: "POST", path: "/v1/projects/project-a/repositories/source/reviews" },
      { method: "GET", path: `/v1/projects/project-a/repositories/source/reviews/${reviewId}` },
      { method: "POST", path: `/v1/projects/project-a/repositories/source/reviews/${reviewId}/approvals` },
      { method: "POST", path: `/v1/projects/project-a/repositories/source/reviews/${reviewId}/revocations` },
      { method: "POST", path: `/v1/projects/project-a/repositories/source/reviews/${reviewId}/ordinary-execution-descriptors` },
      { method: "POST", path: `/v1/projects/project-a/repositories/source/reviews/${reviewId}/job-attempts` },
      { method: "POST", path: `/v1/projects/project-a/repositories/source/reviews/${reviewId}/job-attempt-revocations` },
      { method: "POST", path: `/v1/projects/project-a/repositories/source/reviews/${reviewId}/statuses` },
      { method: "POST", path: `/v1/projects/project-a/repositories/source/reviews/${reviewId}/promotions` }
    ].map(({ method, path }) => fixture.request(
      "ordinary-identity",
      method,
      path,
      method === "GET" ? undefined : {}
    )));
    const git = await fixture.request(
      "ordinary-identity",
      "GET",
      "/v1/projects/project-a/repositories/source.git/info/refs?service=git-upload-pack"
    );
    const oversized = await fixture.request("ordinary-identity", "POST", "/v1/projects/project-a/repositories/source/ordinary-authority/policy", {
      schemaVersion: 1,
      requestId: "00000000-0000-4000-8000-000000000001",
      protectedRef: `refs/heads/${"x".repeat(70_000)}`
    });

    // Then
    expect(denied.map((response) => response.status)).toEqual(roles.map(() => 401));
    expect(query.status).toBe(404);
    expect(wrongMethod.status).toBe(404);
    expect(selector.status).toBe(400);
    expect(genericIdentity.status).toBe(401);
    expect(forbiddenOperations.map((response) => response.status)).toEqual(forbiddenOperations.map(() => 401));
    expect(git.status).toBe(401);
    expect(oversized.status).toBe(400);
    expect(await readdir(`${fixture.repositoryPath}/dim-reviews/job-attempts`)).toEqual(evidenceBefore);
  });
});

async function startFixture(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  return fixture;
}

function proofRequest(fixture: ReviewFixture, endpoint: "policy" | "current-attempt", body: object): Promise<Response> {
  return fixture.request(
    "ordinary-identity",
    "POST",
    `/v1/projects/project-a/repositories/source/ordinary-authority/${endpoint}`,
    body
  );
}

function currentAttemptRequest(
  fixture: ReviewFixture,
  reviewId: string,
  jobName: string,
  attemptId: string
): Promise<Response> {
  return proofRequest(fixture, "current-attempt", {
    schemaVersion: 1,
    requestId: "00000000-0000-4000-8000-000000000002",
    reviewId,
    jobName,
    attemptId
  });
}
