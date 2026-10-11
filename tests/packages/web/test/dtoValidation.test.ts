import { afterEach, describe, expect, it } from "vitest";
import { reviewDto } from "../../../../core/packages/web/src/dto.js";
import { nativeGitReviewFixture, readJsonObject, reviewPath, type ReviewFixture } from "../../native-git/test/nativeGitReviewHarness.js";

const fixtures: ReviewFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("reviewer browser DTO validation", () => {
  it("rejects non-printable evidence strings", async () => {
    // Given
    const review = await validReview();
    const change = review.changes[0];
    if (change === undefined) throw new Error("expected changed path fixture");

    // When
    const inputs = [
      { ...review, protectedRef: "refs/heads/main\nforged" },
      { ...review, patch: `${review.patch}\u0000` },
      { ...review, staleReasons: ["policy-changed\u202e"] },
      { ...review, changes: [{ ...change, newPath: "safe\nforged" }] },
      { ...review, changes: [{ ...change, newSymlinkTarget: "safe\u0000forged" }] }
    ];

    // Then
    for (const input of inputs) expect(() => reviewDto(input)).toThrow();
  });

  it("rejects changed-path collections above the browser rendering bound", async () => {
    // Given
    const review = await validReview();
    const change = review.changes[0];
    if (change === undefined) throw new Error("expected changed path fixture");

    // When
    const parse = () => reviewDto({ ...review, changes: Array.from({ length: 5_001 }, () => change) });

    // Then
    expect(parse).toThrow();
  });
});

async function validReview(): Promise<ReturnType<typeof reviewDto>> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  const response = await fixture.request("reviewer-a-user", "POST", reviewPath(), {
    protectedRef: "refs/heads/main",
    proposalRef: fixture.proposalRef
  });
  return reviewDto(await readJsonObject(response));
}
