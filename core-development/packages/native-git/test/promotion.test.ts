import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApprovedReview,
  promote,
  protectedHead,
  reportRequiredJobs
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

describe("DIM native Git protected promotion", () => {
  it("promotes one fully reviewed candidate with exact successful job evidence and retries idempotently", async () => {
    // Given
    const fixture = await startFixture();
    const review = await createApprovedReview(fixture);
    const statuses = await reportRequiredJobs(fixture, review);
    const before = await protectedHead(fixture);
    await fixture.restart();

    // When
    const first = await promote(fixture, review);
    const after = await protectedHead(fixture);
    const repeated = await promote(fixture, review);

    // Then
    expect(before).toBe(stringField(review, "expectedProtectedHead"));
    expect(statuses.map((status) => stringField(status, "statusId"))).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/)
    ]);
    expect(first.status).toBe(201);
    expect(stringField(await readJsonObject(first), "outcome")).toBe("promoted");
    expect(after).toBe(stringField(review, "candidateCommit"));
    expect(repeated.status).toBe(200);
    expect(stringField(await readJsonObject(repeated), "outcome")).toBe("already-current");
  });

  it("allows exactly one concurrent promotion from the same expected head", async () => {
    // Given
    const fixture = await startFixture();
    const firstReview = await createApprovedReview(fixture);
    await reportRequiredJobs(fixture, firstReview);
    const secondRef = "refs/heads/proposals/workspace-a/change-2";
    await fixture.git(fixture.clone, ["checkout", "-B", "second", "origin/main"]);
    await writeFile(`${fixture.clone}/second.txt`, "second candidate\n");
    await fixture.git(fixture.clone, ["add", "second.txt"]);
    await fixture.git(fixture.clone, ["commit", "-m", "second candidate"]);
    await fixture.git(fixture.clone, ["push", "origin", `HEAD:${secondRef}`]);
    const secondReview = await createApprovedReview(fixture, secondRef);
    await reportRequiredJobs(fixture, secondReview);

    // When
    const responses = await Promise.all([promote(fixture, firstReview), promote(fixture, secondReview)]);
    const head = await protectedHead(fixture);

    // Then
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect([
      stringField(firstReview, "candidateCommit"),
      stringField(secondReview, "candidateCommit")
    ]).toContain(head);
  });

  it("keeps external Git pushes proposal-only after promotion authority exists", async () => {
    // Given
    const fixture = await startFixture();
    const before = await protectedHead(fixture);

    // When
    const attempt = fixture.git(fixture.clone, ["push", "origin", "HEAD:refs/heads/main"]);

    // Then
    await expect(attempt).rejects.toBeDefined();
    expect(await protectedHead(fixture)).toBe(before);
  });
});

async function startFixture(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  return fixture;
}
