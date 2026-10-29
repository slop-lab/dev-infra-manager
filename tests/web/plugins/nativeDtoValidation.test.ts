import { afterEach, describe, expect, it } from "vitest";
import { parseGitReview } from "../../../packages/gs/client/src/index.js";
import { reviewDto } from "@slop-lab/dim-service-client-native-git";
import { decodeDimReviewDetail } from "../../../packages/service-clients/native-git/src/wire-codec.js";
import { installedReviewerFixture, type ReviewFixture } from "./nativeFixture.js";

const fixtures: ReviewFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.close())); });

describe("authoritative review browser DTO", () => {
  it("renders current installed evidence while rejecting unsafe or unbounded text", async () => {
    const fixture = await installedReviewerFixture(); fixtures.push(fixture);
    const response = await fixture.request("owner", "GET", `/v1/projects/project-a/repositories/root/reviews/${fixture.reviewId}`);
    const raw = await response.json() as Record<string, unknown>;
    const review = raw.review as Record<string, unknown>;
    const changes = review.changes as Record<string, unknown>[];
    const decode = (value: unknown) => reviewDto(parseGitReview(decodeDimReviewDetail(value)));
    expect(raw.schemaVersion).toBe(3);
    expect(decode(raw)).toMatchObject({ schemaVersion: 1, repositoryId: "root", policyRevision: review.policyRevision });
    expect(decode(raw)).not.toHaveProperty("qualityRevision");
    for (const updated of [
      { ...review, protectedRef: "refs/heads/main\nforged" },
      { ...review, patch: `${String(review.patch)}\u0000` },
      { ...review, changes: [{ ...changes[0], newPath: "safe\nforged" }] },
      { ...review, changes: Array.from({ length: 5001 }, () => changes[0]) }
    ]) expect(() => decode({ ...raw, review: updated })).toThrow();
    expect(() => decode({ ...raw, staleReasons: ["policy-changed\u202e"] })).toThrow();
    expect(JSON.stringify(decode(raw))).not.toMatch(/patchBytes|password|recordDigest/);
    expect(decode(raw)).not.toHaveProperty("statuses");
  });
});
