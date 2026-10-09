import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeFinalizeService,
  cleanupFinalizeFixtures,
  foreignHumanReviewer,
  generationId,
  humanReviewerAuthorization,
  rootRepository,
  runGit,
  startFinalizeService
} from "./nativeRootImportFinalizeFixture.js";
import { authoritativePolicy } from "./authoritativeNativeCandidateFixture.js";
import { createBundleReview, nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("installed native human approval", () => {
  it("binds a required human approval to the exact current review without moving the protected ref", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("human-approval");
    const { review } = await createBundleReview(fixture.service);
    const endpoint = `${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews/${review.reviewId}`;
    const headers = { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId };
    const reviewPath = join(rootRepository(fixture.root), "dim-authoritative-reviews", "proposals", `${review.reviewId}.json`);
    const reviewBefore = await readFile(reviewPath);
    const protectedBefore = (await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root),
      "rev-parse", "refs/heads/main"])).stdout.trim();

    // When
    const approval = await fetch(`${endpoint}/approvals`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID() })
    });

    // Then
    expect(approval.status).toBe(201);
    const approvalBody: unknown = await approval.json();
    expect(approvalBody).toMatchObject({ reviewId: review.reviewId, reviewerId: "owner" });
    const inspected = await fetch(endpoint, { headers });
    expect(inspected.status).toBe(200);
    expect((await inspected.json()).status).toBe("approved");
    expect((await runGit("/usr/bin/git", ["--git-dir", rootRepository(fixture.root),
      "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(protectedBefore);
    expect(await readFile(reviewPath)).toEqual(reviewBefore);
    const approvalPath = join(rootRepository(fixture.root), "dim-authoritative-approvals", "records",
      `${stringField(approvalBody, "approvalId")}.json`);
    expect((await stat(approvalPath)).mode & 0o777).toBe(0o600);
  });

  it("converges exact replay across restart and rejects a conflicting active request", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("human-approval-replay");
    const { review } = await createBundleReview(fixture.service);
    const path = `/v1/projects/project-a/repositories/root/reviews/${review.reviewId}/approvals`;
    const headers = { authorization: humanReviewerAuthorization, "x-dim-generation-id": generationId,
      "content-type": "application/json" };
    const requestId = randomUUID();
    const first = await fetch(`${fixture.service.origin}${path}`, {
      method: "POST", headers, body: JSON.stringify({ requestId })
    });
    const firstBytes = await first.text();
    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(fixture.root);

    // When
    const replay = await fetch(`${restarted.origin}${path}`, {
      method: "POST", headers, body: JSON.stringify({ requestId })
    });
    const conflict = await fetch(`${restarted.origin}${path}`, {
      method: "POST", headers, body: JSON.stringify({ requestId: randomUUID() })
    });

    // Then
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstBytes);
    expect(conflict.status).toBe(409);
    expect(await readdir(join(rootRepository(fixture.root), "dim-authoritative-approvals", "records")))
      .toHaveLength(1);
  });

  it("requires every path-added reviewer before reporting approved", async () => {
    // Given
    const fixture = await nativeBundleReviewFixture("human-approval-path", undefined,
      authoritativePolicy(["owner"], [{ pathPrefix: "candidate.bin", reviewerIds: ["foreign"] }]));
    const { review } = await createBundleReview(fixture.service);
    const endpoint = `${fixture.service.origin}/v1/projects/project-a/repositories/root/reviews/${review.reviewId}`;
    const headers = { "x-dim-generation-id": generationId, "content-type": "application/json" };

    // When
    await fetch(`${endpoint}/approvals`, { method: "POST", headers: {
      ...headers, authorization: humanReviewerAuthorization
    }, body: JSON.stringify({ requestId: randomUUID() }) });
    const pending = await fetch(endpoint, { headers: { ...headers, authorization: humanReviewerAuthorization } });
    const foreignAuthorization = `Basic ${Buffer.from(
      `${foreignHumanReviewer.username}:${foreignHumanReviewer.password}`
    ).toString("base64")}`;
    await fetch(`${endpoint}/approvals`, { method: "POST", headers: {
      ...headers, authorization: foreignAuthorization
    }, body: JSON.stringify({ requestId: randomUUID() }) });
    const approved = await fetch(endpoint, { headers: { ...headers, authorization: foreignAuthorization } });

    // Then
    expect((await pending.json()).status).toBe("pending");
    expect((await approved.json()).status).toBe("approved");
  });
});

function stringField(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ApprovalFixtureError();
  const selected = Reflect.get(value, field);
  if (typeof selected !== "string") throw new ApprovalFixtureError();
  return selected;
}

class ApprovalFixtureError extends Error {
  readonly name = "ApprovalFixtureError";
}
