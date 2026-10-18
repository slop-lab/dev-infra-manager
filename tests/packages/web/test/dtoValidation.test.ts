import { afterEach, describe, expect, it } from "vitest";
import { reviewDto } from "../../../../core/packages/web/src/dto.js";
import { installedReviewerFixture, type ReviewFixture } from "./webHarness.js";

const fixtures: ReviewFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.close())); });

describe("authoritative review browser DTO", () => {
  it("renders current installed evidence while rejecting unsafe or unbounded text", async () => {
    const fixture = await installedReviewerFixture(); fixtures.push(fixture);
    const response = await fixture.request("owner", "GET", `/v1/projects/project-a/repositories/root/reviews/${fixture.reviewId}`);
    const raw = await response.json() as Record<string, unknown>;
    const review = raw.review as Record<string, unknown>;
    const changes = review.changes as Record<string, unknown>[];
    expect(reviewDto(raw)).toMatchObject({ schemaVersion: 2, repositoryId: "root", qualityRevision: raw.qualityRevision });
    for (const updated of [
      { ...review, protectedRef: "refs/heads/main\nforged" },
      { ...review, patch: `${String(review.patch)}\u0000` },
      { ...review, changes: [{ ...changes[0], newPath: "safe\nforged" }] },
      { ...review, changes: Array.from({ length: 5001 }, () => changes[0]) }
    ]) expect(() => reviewDto({ ...raw, review: updated })).toThrow();
    expect(() => reviewDto({ ...raw, staleReasons: ["policy-changed\u202e"] })).toThrow();
    expect(JSON.stringify(reviewDto(raw))).not.toMatch(/patchBytes|password|recordDigest/);
    expect(reviewDto(raw)).not.toHaveProperty("statuses");
  });
});
