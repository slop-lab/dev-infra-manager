import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  candidateOrdinaryExecutionDescriptorSchema,
  descriptorDigest
} from "../../../../core/packages/native-git/src/index.js";
import {
  createApprovedReview,
  issueJob,
  promote,
  protectedHead,
  reportJob,
  reportRequiredJobs,
  revokeJobAttempt,
  revokeLastApproval
} from "./nativeGitPromotionHarness.js";
import {
  nativeGitReviewFixture,
  objectField,
  readJsonObject,
  reviewPath,
  stringField,
  type ReviewFixture
} from "./nativeGitReviewHarness.js";

const fixtures: ReviewFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("DIM native Git protected promotion denials", () => {
  it("rejects missing required CI evidence without changing the protected ref", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    expect((await reportJob(fixture, review, "source", await issueJob(fixture, review, "source"))).status).toBe(201);
    const before = await protectedHead(fixture);

    const response = await promote(fixture, review);

    expect(response.status).toBe(409);
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("rejects the latest failed attempt even when an earlier attempt succeeded", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    await reportRequiredJobs(fixture, review);
    const secondAttempt = await issueJob(fixture, review, "source");
    expect((await reportJob(fixture, review, "source", secondAttempt, "failure")).status).toBe(201);
    const before = await protectedHead(fixture);

    const response = await promote(fixture, review);

    expect(response.status).toBe(409);
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("rejects a fabricated future CI attempt without changing the protected ref", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    const security = await issueJob(fixture, review, "security");
    expect((await reportJob(fixture, review, "security", security)).status).toBe(201);
    const source = await issueJob(fixture, review, "source");
    const before = await protectedHead(fixture);

    const fabricated = await reportJob(fixture, review, "source", source, "success", "ordinary-results", { attempt: 999 });
    const unknown = await reportJob(fixture, review, "source", source, "success", "ordinary-results", {
      attemptId: "00000000-0000-4000-8000-000000000001"
    });
    const response = await promote(fixture, review);

    expect([fabricated.status, unknown.status, response.status]).toEqual([409, 409, 409]);
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("rejects conflicting evidence for one job attempt", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    const source = await issueJob(fixture, review, "source");
    expect((await reportJob(fixture, review, "source", source)).status).toBe(201);
    const before = await protectedHead(fixture);

    const conflicting = await reportJob(fixture, review, "source", source, "failure");
    const response = await promote(fixture, review);

    expect(conflicting.status).toBe(409);
    expect(response.status).toBe(409);
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("rejects nonterminal and wrong-project status injection without changing the ref", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    const before = await protectedHead(fixture);
    const source = await issueJob(fixture, review, "source");

    const nonterminal = await reportJob(fixture, review, "source", source, "running");
    const accepted = await readJsonObject(await reportJob(fixture, review, "source", source));
    const {
      statusId: _statusId,
      reviewId: _reviewId,
      reporterUsername: _reporterUsername,
      reportedAt: _reportedAt,
      ...envelope
    } = accepted;
    const foreign = await fixture.request(
      "ordinary-results",
      "POST",
      `/v1/projects/project-b/repositories/source/reviews/${stringField(review, "reviewId")}/statuses`,
      envelope
    );
    const response = await promote(fixture, review);

    expect(nonterminal.status).toBe(400);
    expect(foreign.status).toBe(404);
    expect(response.status).toBe(409);
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("rejects a status whose candidate tuple differs from the review", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    const before = await protectedHead(fixture);
    const source = await issueJob(fixture, review, "source");

    const changedDescriptor = candidateOrdinaryExecutionDescriptorSchema.parse({
      ...objectField(source, "descriptor"),
      candidateCommit: before
    });
    const injected = await reportJob(fixture, review, "source", source, "success", "ordinary-results", {
      descriptor: changedDescriptor,
      descriptorDigest: descriptorDigest(changedDescriptor)
    });
    const response = await promote(fixture, review);

    expect(injected.status).toBe(409);
    expect(response.status).toBe(409);
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("rejects late and revoked issued attempts across restart", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    const oldAttempt = await issueJob(fixture, review, "source");
    const currentAttempt = await issueJob(fixture, review, "source");
    expect((await revokeJobAttempt(fixture, review, "source", currentAttempt)).status).toBe(201);
    await fixture.restart();
    const before = await protectedHead(fixture);

    const late = await reportJob(fixture, review, "source", oldAttempt);
    const revoked = await reportJob(fixture, review, "source", currentAttempt);

    expect([late.status, revoked.status]).toEqual([409, 409]);
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("rejects revoked approval and changed policy without changing the ref", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    await reportRequiredJobs(fixture, review);
    await revokeLastApproval(fixture, review);
    const before = await protectedHead(fixture);

    const revoked = await promote(fixture, review);
    await fixture.restart(fixture.configWithPolicyRevision("policy-2"));
    const changedPolicy = await promote(fixture, review);

    expect(revoked.status).toBe(409);
    expect(changedPolicy.status).toBe(409);
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("rejects stale approval identity without changing the ref", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    await reportRequiredJobs(fixture, review);
    const before = await protectedHead(fixture);
    await fixture.restart(fixture.configWithIdentityUsername("reviewer-a-user", "reviewer-a-replaced"));

    const response = await promote(fixture, review);

    expect(response.status).toBe(409);
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("rejects a stale protected head without overwriting the moved ref", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    await reportRequiredJobs(fixture, review);
    await writeFile(`${fixture.clone}/moved.txt`, "moved head\n");
    await fixture.git(fixture.clone, ["add", "moved.txt"]);
    await fixture.git(fixture.clone, ["commit", "-m", "move protected head"]);
    const moved = (await fixture.git(fixture.clone, ["rev-parse", "HEAD"])).stdout.trim();
    await fixture.git(fixture.clone, ["push", "origin", "HEAD:refs/heads/proposals/workspace-a/head-move"]);
    await fixture.git(fixture.root, ["--git-dir", fixture.repositoryPath, "update-ref", "refs/heads/main", moved]);

    const response = await promote(fixture, review);

    expect(response.status).toBe(409);
    expect(await protectedHead(fixture)).toBe(moved);
  });

  it("rejects a non-descendant reviewed candidate without changing the ref", async () => {
    const fixture = await approvedFixture();
    await fixture.git(fixture.clone, ["checkout", "--orphan", "unrelated"]);
    await fixture.git(fixture.clone, ["rm", "-rf", "."]);
    await writeFile(`${fixture.clone}/unrelated.txt`, "unrelated\n");
    await fixture.git(fixture.clone, ["add", "unrelated.txt"]);
    await fixture.git(fixture.clone, ["commit", "-m", "unrelated candidate"]);
    const unrelatedRef = "refs/heads/proposals/workspace-a/unrelated";
    await fixture.git(fixture.clone, ["push", "origin", `HEAD:${unrelatedRef}`]);
    const review = await createApprovedReview(fixture, unrelatedRef);
    const before = await protectedHead(fixture);

    const issuance = issueJob(fixture, review, "source");

    await expect(issuance).rejects.toBeDefined();
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("fails closed on injected status state during restart", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    await reportRequiredJobs(fixture, review);
    const before = await protectedHead(fixture);
    const statusRoot = `${fixture.repositoryPath}/dim-reviews/statuses/${stringField(review, "reviewId")}`;
    await mkdir(statusRoot, { recursive: true });
    await writeFile(`${statusRoot}/injected.json`, "{}\n", { mode: 0o600 });

    const restart = fixture.restart();

    await expect(restart).rejects.toBeDefined();
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("fails closed when an issued attempt record does not match its path", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    const issuance = await issueJob(fixture, review, "source");
    const before = await protectedHead(fixture);
    const attemptRoot = `${fixture.repositoryPath}/dim-reviews/job-attempts/${stringField(review, "reviewId")}/source`;
    await writeFile(`${attemptRoot}/2.json`, `${JSON.stringify(issuance)}\n`, { mode: 0o600 });

    const restart = fixture.restart();

    await expect(restart).rejects.toBeDefined();
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("denies administrator and result-reporter promotion authority", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    await reportRequiredJobs(fixture, review);
    const before = await protectedHead(fixture);

    const administrator = await promote(fixture, review, "admin-a");
    const ci = await promote(fixture, review, "ordinary-results");
    const validIssuance = await issueJob(fixture, review, "source");
    const issueBody = {
      issuanceRequestId: "00000000-0000-4000-8000-000000000201",
      jobName: "source",
      descriptorDigest: stringField(validIssuance, "descriptorDigest"),
      admissionGeneration: "generation-7",
      runnerBaseImage: `registry.example/runner@sha256:${"3".repeat(64)}`,
      bounds: objectField(objectField(validIssuance, "descriptor"), "bounds"),
      hostId: "host-a",
      capacity: "primary"
    };
    const administratorIssue = await fixture.request(
      "admin-a", "POST", reviewPath(`/${stringField(review, "reviewId")}/job-attempts`), issueBody
    );
    const ciIssue = await fixture.request(
      "ordinary-results", "POST", reviewPath(`/${stringField(review, "reviewId")}/job-attempts`), issueBody
    );

    expect([administrator.status, ci.status, administratorIssue.status, ciIssue.status]).toEqual([403, 403, 403, 403]);
    expect(await protectedHead(fixture)).toBe(before);
  });
});

async function approvedFixture(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  return fixture;
}
