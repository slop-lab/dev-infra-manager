import { access, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  nativeGitReviewFixture,
  objectField,
  readJsonObject,
  reviewPath,
  stringField,
  type JsonObject,
  type ReviewFixture
} from "./nativeGitReviewHarness.js";

const fixtures: ReviewFixture[] = [];
const runnerBaseImage = `registry.example/runner@sha256:${"3".repeat(64)}`;
const descriptorBody = {
  jobName: "source",
  admissionGeneration: "generation-7",
  runnerBaseImage,
  bounds: {
    cpu: "2",
    memoryBytes: "2147483648",
    pids: "512",
    wallClockSeconds: "900",
    outputBytes: "10485760"
  }
} as const;

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("DIM native Git ordinary execution descriptor API", () => {
  it("returns the exact pending-review descriptor deterministically without creating attempt or status state", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createPendingReview(fixture);
    const path = descriptorPath(review);

    // When
    const first = await fixture.request("scheduler-a", "POST", path, descriptorBody);
    const second = await fixture.request("scheduler-a", "POST", path, descriptorBody);

    // Then
    expect([first.status, second.status]).toEqual([200, 200]);
    const firstBody = await readJsonObject(first);
    const secondBody = await readJsonObject(second);
    const descriptor = objectField(firstBody, "descriptor");
    expect(secondBody).toEqual(firstBody);
    expect(firstBody).toEqual({
      reviewId: stringField(review, "reviewId"),
      descriptor: expect.objectContaining({
        projectId: "project-a",
        repositoryId: "source",
        protectedRef: "refs/heads/main",
        expectedProtectedHead: stringField(review, "expectedProtectedHead"),
        candidateCommit: stringField(review, "candidateCommit"),
        candidateTree: stringField(review, "candidateTree"),
        policyRevision: "policy-1",
        requiredReviewRevision: "review-1",
        requiredJobSetRevision: "jobs-1",
        ...descriptorBody,
        evidenceClass: "candidate-controlled",
        argv: ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"],
        jobImage: `registry.example/source@sha256:${"1".repeat(64)}`
      }),
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    });
    expect(Object.keys(descriptor).sort()).toEqual([
      "admissionGeneration", "argv", "bounds", "candidateCommit", "candidateTree", "configBlob",
      "evidenceClass", "expectedProtectedHead", "jobImage", "jobName", "policyRevision", "projectId",
      "protectedRef", "repositoryId", "requiredJobSetRevision", "requiredReviewRevision", "runnerBaseImage",
      "script"
    ].sort());
    expect(Object.keys(objectField(descriptor, "configBlob")).sort()).toEqual(["objectId", "sha256"]);
    expect(Object.keys(objectField(descriptor, "script")).sort()).toEqual(["objectId", "path", "sha256"]);
    expect(JSON.stringify(firstBody)).not.toMatch(/password|secret|attemptId|writerUsername|patch/);
    await expectNoExecutionWrites(fixture);
  });

  it("conceals foreign scope and rejects a non-scheduler role", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createPendingReview(fixture);
    const reviewId = stringField(review, "reviewId");

    // When
    const foreign = await fixture.request(
      "scheduler-a",
      "POST",
      `/v1/projects/project-b/repositories/source/reviews/${reviewId}/ordinary-execution-descriptors`,
      { ...descriptorBody, candidateCommit: "0".repeat(40) }
    );
    const reviewer = await fixture.request(
      "reviewer-a-user",
      "POST",
      descriptorPath(review),
      { ...descriptorBody, candidateCommit: "0".repeat(40) }
    );

    // Then
    expect([foreign.status, reviewer.status]).toEqual([404, 403]);
    await expectNoExecutionWrites(fixture);
  });

  it.each([
    ["unknown candidate tuple", { ...descriptorBody, candidateCommit: "0".repeat(40) }],
    ["unknown attempt", { ...descriptorBody, attemptId: "00000000-0000-4000-8000-000000000001" }],
    ["noncanonical bounds", { ...descriptorBody, bounds: { ...descriptorBody.bounds, cpu: "02" } }]
  ])("rejects %s fields", async (_label, body) => {
    // Given
    const fixture = await startFixture();
    const review = await createPendingReview(fixture);

    // When
    const response = await fixture.request("scheduler-a", "POST", descriptorPath(review), body);

    // Then
    expect(response.status).toBe(400);
    await expectNoExecutionWrites(fixture);
  });

  it("rejects malformed JSON, non-exact content type, query strings, and an unknown review", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createPendingReview(fixture);
    const authorization = `Basic ${Buffer.from("scheduler-a:scheduler-a-secret").toString("base64")}`;
    const endpoint = `${fixture.baseUrl()}${descriptorPath(review)}`;

    // When
    const malformed = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: "{"
    });
    const contentType = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(descriptorBody)
    });
    const oversized = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ ...descriptorBody, padding: "x".repeat(64 * 1024) })
    });
    const query = await fixture.request("scheduler-a", "POST", `${descriptorPath(review)}?job=source`, descriptorBody);
    const missing = await fixture.request(
      "scheduler-a",
      "POST",
      reviewPath(`/${"0".repeat(64)}/ordinary-execution-descriptors`),
      descriptorBody
    );

    // Then
    expect([malformed.status, contentType.status, oversized.status, query.status, missing.status])
      .toEqual([400, 400, 400, 404, 404]);
    await expectNoExecutionWrites(fixture);
  });

  it("rejects stale proposal drift without creating attempt or status state", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createPendingReview(fixture);
    await moveProposal(fixture, "stale-after-review.txt");

    // When
    const response = await fixture.request("scheduler-a", "POST", descriptorPath(review), descriptorBody);

    // Then
    expect(response.status).toBe(409);
    await expectNoExecutionWrites(fixture);
  });

  it("rechecks proposal drift after candidate blobs are read", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createPendingReview(fixture);
    await fixture.candidateReadGate.arm();

    // When
    const pending = fixture.request("scheduler-a", "POST", descriptorPath(review), descriptorBody);
    await vi.waitFor(() => expect(access(join(fixture.root, "candidate-read-entered"))).resolves.toBeUndefined());
    await moveProposal(fixture, "raced-after-status.txt");
    await fixture.candidateReadGate.release();
    const response = await pending;

    // Then
    expect(response.status).toBe(409);
    await expectNoExecutionWrites(fixture);
  });

  it("denies scheduler smart Git upload-pack discovery and RPC", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const response = await fetch(
      `${fixture.baseUrl()}/v1/projects/project-a/repositories/source.git/info/refs?service=git-upload-pack`,
      { headers: { Authorization: `Basic ${Buffer.from("scheduler-a:scheduler-a-secret").toString("base64")}` } }
    );
    const rpc = await fetch(`${fixture.baseUrl()}/v1/projects/project-a/repositories/source.git/git-upload-pack`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from("scheduler-a:scheduler-a-secret").toString("base64")}`,
        "Content-Type": "application/x-git-upload-pack-request"
      },
      body: "0000"
    });

    // Then
    expect([response.status, rpc.status]).toEqual([403, 403]);
  });
});

async function startFixture(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  return fixture;
}

async function createPendingReview(fixture: ReviewFixture): Promise<JsonObject> {
  const response = await fixture.request("reviewer-a-user", "POST", reviewPath(), {
    protectedRef: "refs/heads/main",
    proposalRef: fixture.proposalRef
  });
  expect(response.status).toBe(201);
  return readJsonObject(response);
}

function descriptorPath(review: JsonObject): string {
  return reviewPath(`/${stringField(review, "reviewId")}/ordinary-execution-descriptors`);
}

async function moveProposal(fixture: ReviewFixture, file: string): Promise<void> {
  await writeFile(join(fixture.clone, file), "proposal moved\n");
  await fixture.git(fixture.clone, ["add", file]);
  await fixture.git(fixture.clone, ["commit", "-m", file]);
  await fixture.git(fixture.clone, ["push", "origin", `HEAD:${fixture.proposalRef}`]);
}

async function expectNoExecutionWrites(fixture: ReviewFixture): Promise<void> {
  const reviewRoot = join(fixture.repositoryPath, "dim-reviews");
  expect(await readdir(join(reviewRoot, "job-attempts"))).toEqual([]);
  expect(await readdir(join(reviewRoot, "statuses"))).toEqual([]);
}
