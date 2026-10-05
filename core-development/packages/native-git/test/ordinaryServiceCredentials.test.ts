import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApprovedReview,
  issueJob,
  protectedHead,
  reportJob
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

describe("DIM native Git ordinary CI service credentials", () => {
  it("limits issuer and reporter to their exact receipt-bound HTTP operations", async () => {
    const fixture = await startFixture();
    const review = await createApprovedReview(fixture);
    const reviewId = stringField(review, "reviewId");
    const before = await protectedHead(fixture);
    const issuance = await issueJob(fixture, review, "source");
    const issueBody = {
      issuanceRequestId: randomUUID(),
      jobName: "source",
      descriptorDigest: stringField(issuance, "descriptorDigest"),
      admissionGeneration: "generation-7",
      runnerBaseImage: `registry.example/runner@sha256:${"3".repeat(64)}`,
      bounds: objectField(objectField(issuance, "descriptor"), "bounds"),
      hostId: "host-a",
      capacity: "primary"
    };

    const issuerReport = await reportJob(fixture, review, "source", issuance, "success", "ordinary-attempts");
    const reporterIssue = await fixture.request(
      "ordinary-results", "POST", reviewPath(`/${reviewId}/job-attempts`), issueBody
    );
    const reporterRevoke = await fixture.request(
      "ordinary-results", "POST", reviewPath(`/${reviewId}/job-attempt-revocations`), {
        jobName: "source",
        attemptId: stringField(issuance, "attemptId")
      }
    );
    const forbidden = await Promise.all(["ordinary-attempts", "ordinary-results"].flatMap((identity) => [
      fixture.request(identity, "GET", reviewPath(`/${reviewId}`)),
      fixture.request(identity, "POST", reviewPath(`/${reviewId}/approvals`), {}),
      fixture.request(identity, "POST", reviewPath(`/${reviewId}/promotions`), {}),
      fixture.request(identity, "GET", "/v1/projects/project-a/repositories/source.git/info/refs?service=git-upload-pack")
    ]));
    const oldScheduler = await fixture.request(
      "scheduler-a", "POST", reviewPath(`/${reviewId}/job-attempts`), issueBody
    );
    const oldReporter = await reportJob(fixture, review, "source", issuance, "success", "source-ci");

    expect([issuerReport.status, reporterIssue.status, reporterRevoke.status]).toEqual([403, 403, 403]);
    expect(forbidden.map((response) => response.status)).toEqual(forbidden.map(() => 403));
    expect([oldScheduler.status, oldReporter.status]).toEqual([401, 401]);
    expect(await protectedHead(fixture)).toBe(before);
  });

  it("accepts only the exact current v2 terminal tuple and rejects replay after G1 rotation or revocation", async () => {
    const fixture = await startFixture();
    const review = await createApprovedReview(fixture);
    const before = await protectedHead(fixture);
    const issuance = await issueJob(fixture, review, "source");

    const wrongHost = await reportJob(fixture, review, "source", issuance, "success", "ordinary-results", {
      hostId: "host-b"
    });
    const accepted = await reportJob(fixture, review, "source", issuance);
    const acceptedRecord = await readJsonObject(accepted);
    fixture.setAdmissionGeneration("generation-8");
    const rotatedReplay = await replayStatus(fixture, acceptedRecord, review);
    fixture.setAdmissionGeneration("generation-7");
    const revoked = await fixture.request(
      "ordinary-attempts", "POST", reviewPath(`/${stringField(review, "reviewId")}/job-attempt-revocations`), {
        jobName: "source",
        attemptId: stringField(issuance, "attemptId")
      }
    );
    const revokedReplay = await replayStatus(fixture, acceptedRecord, review);

    expect([wrongHost.status, accepted.status, rotatedReplay.status, revoked.status, revokedReplay.status])
      .toEqual([409, 201, 500, 201, 409]);
    expect(await protectedHead(fixture)).toBe(before);
  });
});

async function startFixture(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  return fixture;
}

function replayStatus(
  fixture: ReviewFixture,
  record: Readonly<Record<string, unknown>>,
  review: Readonly<Record<string, unknown>>
): Promise<Response> {
  const {
    statusId: _statusId,
    reviewId: _reviewId,
    reporterUsername: _reporterUsername,
    reportedAt: _reportedAt,
    ...envelope
  } = record;
  return fixture.request(
    "ordinary-results",
    "POST",
    reviewPath(`/${stringField(review, "reviewId")}/statuses`),
    envelope
  );
}
