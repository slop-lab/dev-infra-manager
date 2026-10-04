import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { refValue } from "./nativeGitHarness.js";
import {
  objectArrayField,
  objectField,
  readJsonObject,
  reviewPath,
  stringArrayField,
  stringField,
  type JsonObject,
  type ReviewFixture
} from "./nativeGitReviewHarness.js";

export async function createApprovedReview(fixture: ReviewFixture, proposalRef = fixture.proposalRef): Promise<JsonObject> {
  const response = await fixture.request("reviewer-a-user", "POST", reviewPath(), {
    protectedRef: "refs/heads/main",
    proposalRef
  });
  expect(response.status).toBe(201);
  const review = await readJsonObject(response);
  const reviewId = stringField(review, "reviewId");
  const identities: Readonly<Record<string, string>> = {
    "docs-reviewer": "docs-reviewer-user",
    "reviewer-a": "reviewer-a-user"
  };
  for (const reviewerId of stringArrayField(review, "requiredReviewerIds")) {
    const reviewer = identities[reviewerId];
    if (reviewer === undefined) throw new Error(`missing fixture reviewer: ${reviewerId}`);
    const approval = await fixture.request(reviewer, "POST", reviewPath(`/${reviewId}/approvals`), {});
    expect(approval.status).toBe(201);
  }
  return review;
}

export async function reportJob(
  fixture: ReviewFixture,
  review: JsonObject,
  jobName: "source" | "security",
  issuance: JsonObject,
  result: "success" | "failure" | "cancelled" | "running" = "success",
  identity = `${jobName}-ci`,
  payloadOverrides: JsonObject = {}
): Promise<Response> {
  const reviewId = stringField(review, "reviewId");
  const attempt = issuance["attempt"];
  if (typeof attempt !== "number") throw new Error("issued job attempt is missing its number");
  const descriptor = objectField(issuance, "descriptor");
  const now = new Date().toISOString();
  const completion = result === "success"
    ? { kind: "exited", exitCode: 0 }
    : result === "cancelled"
      ? { kind: "cancelled" }
      : { kind: "exited", exitCode: 1 };
  return fixture.request(identity, "POST", reviewPath(`/${reviewId}/statuses`), {
    schemaVersion: 2,
    eventId: randomUUID(),
    occurredAt: now,
    eventType: "dim.ci.job.completed",
    payload: {
      reviewId,
      attempt,
      attemptId: stringField(issuance, "attemptId"),
      descriptor,
      descriptorDigest: stringField(issuance, "descriptorDigest"),
      hostId: stringField(issuance, "hostId"),
      capacity: stringField(issuance, "capacity"),
      startedAt: now,
      finishedAt: now,
      result,
      completion,
      stdout: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false },
      stderr: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false },
      ...payloadOverrides
    }
  });
}

export async function issueJob(
  fixture: ReviewFixture,
  review: JsonObject,
  jobName: "source" | "security"
): Promise<JsonObject> {
  const response = await requestJob(fixture, review, jobName);
  expect(response.status).toBe(201);
  return readJsonObject(response);
}

export async function requestJob(
  fixture: ReviewFixture,
  review: JsonObject,
  jobName: "source" | "security"
): Promise<Response> {
  const reviewId = stringField(review, "reviewId");
  const descriptorResponse = await fixture.request(
    "scheduler-a",
    "POST",
    reviewPath(`/${reviewId}/ordinary-execution-descriptors`),
    {
      jobName,
      admissionGeneration: "generation-7",
      runnerBaseImage: `registry.example/runner@sha256:${"3".repeat(64)}`,
      bounds: {
        cpu: "2",
        memoryBytes: "2147483648",
        pids: "512",
        wallClockSeconds: "900",
        outputBytes: "10485760"
      }
    }
  );
  expect(descriptorResponse.status).toBe(200);
  const descriptorResult = await readJsonObject(descriptorResponse);
  return fixture.request("scheduler-a", "POST", reviewPath(`/${stringField(review, "reviewId")}/job-attempts`), {
    issuanceRequestId: randomUUID(),
    jobName,
    descriptorDigest: stringField(descriptorResult, "digest"),
    admissionGeneration: "generation-7",
    runnerBaseImage: `registry.example/runner@sha256:${"3".repeat(64)}`,
    bounds: objectField(objectField(descriptorResult, "descriptor"), "bounds"),
    hostId: "host-a",
    capacity: "primary"
  });
}

export async function revokeJobAttempt(
  fixture: ReviewFixture,
  review: JsonObject,
  jobName: "source" | "security",
  issuance: JsonObject
): Promise<Response> {
  return fixture.request("scheduler-a", "POST", reviewPath(`/${stringField(review, "reviewId")}/job-attempt-revocations`), {
    jobName,
    attemptId: stringField(issuance, "attemptId")
  });
}

export async function reportRequiredJobs(fixture: ReviewFixture, review: JsonObject): Promise<readonly JsonObject[]> {
  const records: JsonObject[] = [];
  for (const jobName of ["source", "security"] as const) {
    const response = await reportJob(fixture, review, jobName, await issueJob(fixture, review, jobName));
    expect(response.status).toBe(201);
    records.push(await readJsonObject(response));
  }
  return records;
}

export async function promote(fixture: ReviewFixture, review: JsonObject, identity = "promoter-a"): Promise<Response> {
  return fixture.request(identity, "POST", reviewPath(`/${stringField(review, "reviewId")}/promotions`), {});
}

export async function revokeLastApproval(fixture: ReviewFixture, review: JsonObject): Promise<void> {
  const reviewId = stringField(review, "reviewId");
  const current = await fixture.request("admin-a", "GET", reviewPath(`/${reviewId}`));
  expect(current.status).toBe(200);
  const approvals = objectArrayField(await readJsonObject(current), "approvals");
  const approval = approvals.at(-1);
  if (approval === undefined) throw new Error("expected an approval");
  const response = await fixture.request("admin-a", "POST", reviewPath(`/${reviewId}/revocations`), {
    approvalId: stringField(approval, "approvalId")
  });
  expect(response.status).toBe(201);
}

export async function protectedHead(fixture: ReviewFixture): Promise<string> {
  const value = await refValue(fixture.repositoryPath, "refs/heads/main");
  if (value === undefined) throw new Error("protected ref is missing");
  return value;
}
