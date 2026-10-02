import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { refValue } from "./nativeGitHarness.js";
import {
  objectArrayField,
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
  attempt = 1,
  result: "success" | "failure" | "cancelled" | "running" = "success",
  identity = `${jobName}-ci`,
  payloadOverrides: JsonObject = {}
): Promise<Response> {
  const reviewId = stringField(review, "reviewId");
  return fixture.request(identity, "POST", reviewPath(`/${reviewId}/statuses`), {
    schemaVersion: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    eventType: "dim.ci.job.completed",
    payload: {
      projectId: stringField(review, "projectId"),
      repositoryId: stringField(review, "repositoryId"),
      protectedRef: stringField(review, "protectedRef"),
      expectedProtectedHead: stringField(review, "expectedProtectedHead"),
      candidateCommit: stringField(review, "candidateCommit"),
      candidateTree: stringField(review, "candidateTree"),
      policyRevision: stringField(review, "policyRevision"),
      requiredReviewRevision: stringField(review, "requiredReviewRevision"),
      requiredJobSetRevision: stringField(review, "requiredJobSetRevision"),
      jobName,
      attempt,
      result,
      ...payloadOverrides
    }
  });
}

export async function reportRequiredJobs(fixture: ReviewFixture, review: JsonObject): Promise<readonly JsonObject[]> {
  const records: JsonObject[] = [];
  for (const jobName of ["source", "security"] as const) {
    const response = await reportJob(fixture, review, jobName);
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
