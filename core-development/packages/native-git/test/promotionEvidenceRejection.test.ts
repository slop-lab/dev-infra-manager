import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApprovedReview,
  issueJob,
  promote,
  protectedHead,
  requestJob,
  reportJob,
  reportRequiredJobs,
  revokeJobAttempt
} from "./nativeGitPromotionHarness.js";
import {
  nativeGitReviewFixture,
  readJsonObject,
  stringField,
  type ReviewFixture
} from "./nativeGitReviewHarness.js";

const fixtures: ReviewFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("DIM native Git descriptor evidence denials", () => {
  it("rejects a wrong host assignment and malformed terminal evidence without changing the ref", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    const source = await issueJob(fixture, review, "source");
    const before = await protectedHead(fixture);

    const wrongHost = await reportJob(fixture, review, "source", source, "success", "source-ci", {
      hostId: "host-b"
    });
    const nonzeroSuccess = await reportJob(fixture, review, "source", source, "success", "source-ci", {
      completion: { kind: "exited", exitCode: 7 }
    });
    const reversedTime = await reportJob(fixture, review, "source", source, "success", "source-ci", {
      startedAt: "2026-10-04T22:00:01.000Z",
      finishedAt: "2026-10-04T22:00:00.000Z"
    });
    const excessiveOutput = await reportJob(fixture, review, "source", source, "success", "source-ci", {
      stdout: { bytes: "10485761", sha256: `sha256:${"0".repeat(64)}`, truncated: true }
    });

    expect([wrongHost.status, nonzeroSuccess.status, reversedTime.status, excessiveOutput.status])
      .toEqual([409, 400, 400, 400]);
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("rejects G1 success after G2 admission rotation without changing the protected ref", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    await reportRequiredJobs(fixture, review);
    const before = await protectedHead(fixture);
    fixture.setAdmissionGeneration("generation-8");

    const response = await promote(fixture, review);

    expect(response.status).toBe(500);
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("fails closed on verifier outage at report and promotion", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    const source = await issueJob(fixture, review, "source");
    const before = await protectedHead(fixture);
    fixture.setAdmissionVerifierAvailable(false);

    const reportDuringOutage = await reportJob(fixture, review, "source", source);
    fixture.setAdmissionVerifierAvailable(true);
    await reportRequiredJobs(fixture, review);
    fixture.setAdmissionVerifierAvailable(false);
    const promotionDuringOutage = await promote(fixture, review);

    expect([reportDuringOutage.status, promotionDuringOutage.status]).toEqual([500, 500]);
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("bounds a hanging verifier during issuance and releases the serializer without a late write", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    fixture.hangAdmissionVerifier("admitted");

    const timedOut = await requestJob(fixture, review, "source");
    expect(timedOut.status).toBe(500);
    fixture.releaseAdmissionVerifier();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const issued = await issueJob(fixture, review, "source");
    expect(issued["attempt"]).toBe(1);
  });

  it("bounds a hanging verifier during reporting and permits a subsequent valid report", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    const issuance = await issueJob(fixture, review, "source");
    fixture.hangAdmissionVerifier("current");

    const timedOut = await reportJob(fixture, review, "source", issuance);
    expect(timedOut.status).toBe(500);
    fixture.releaseAdmissionVerifier();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await reportJob(fixture, review, "source", issuance)).status).toBe(201);
  });

  it("bounds a hanging verifier during promotion and permits a subsequent valid promotion", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    await reportRequiredJobs(fixture, review);
    const before = await protectedHead(fixture);
    fixture.hangAdmissionVerifier("current");

    const timedOut = await promote(fixture, review);
    expect(timedOut.status).toBe(500);
    expect(await protectedHead(fixture)).toBe(before);
    fixture.releaseAdmissionVerifier();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await promote(fixture, review)).status).toBe(201);
  });

  it("rejects descriptor-digest-only tampering", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    const issuance = await issueJob(fixture, review, "source");

    const response = await reportJob(fixture, review, "source", issuance, "success", "source-ci", {
      descriptorDigest: `sha256:${"f".repeat(64)}`
    });

    expect(response.status).toBe(400);
  });

  it("fails closed when production has no configured admission verifier", async () => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    const before = await protectedHead(fixture);
    await fixture.restartWithoutAdmissionVerifier();

    const issuance = issueJob(fixture, review, "source");

    await expect(issuance).rejects.toBeDefined();
    expect(await protectedHead(fixture)).toBe(before);
  });

  it.each([
    ["attempt", "job-attempts"],
    ["status", "statuses"],
    ["revocation", "job-attempt-revocations"]
  ] as const)("rejects legacy v1 %s state at startup without rewriting it", async (kind, directory) => {
    const fixture = await approvedFixture();
    const review = await createApprovedReview(fixture);
    const issuance = await issueJob(fixture, review, "source");
    const record = kind === "attempt"
      ? issuance
      : await readJsonObject(kind === "status"
        ? await reportJob(fixture, review, "source", issuance)
        : await revokeJobAttempt(fixture, review, "source", issuance));
    const before = await protectedHead(fixture);
    const path = `${fixture.repositoryPath}/dim-reviews/${directory}/${stringField(review, "reviewId")}/source/1.json`;
    const legacy = `${JSON.stringify({ ...record, schemaVersion: 1 })}\n`;
    await writeFile(path, legacy, { mode: 0o600 });

    const restart = fixture.restart();

    await expect(restart).rejects.toBeDefined();
    expect(await readFile(path, "utf8")).toBe(legacy);
    expect(await protectedHead(fixture)).toBe(before);
  });
});

async function approvedFixture(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  return fixture;
}
