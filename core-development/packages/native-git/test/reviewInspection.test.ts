import { afterEach, describe, expect, it } from "vitest";
import { refValue } from "./nativeGitHarness.js";
import {
  nativeGitReviewFixture,
  objectArrayField,
  readJsonObject,
  reviewPath,
  stringArrayField,
  stringField,
  type ReviewFixture
} from "./nativeGitReviewHarness.js";

const fixtures: ReviewFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("DIM native Git complete-tree review inspection", () => {
  it("records the exact proposal tuple and complete changed-path evidence", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const response = await fixture.request("reviewer-a-user", "POST", reviewPath(), {
      protectedRef: "refs/heads/main",
      proposalRef: fixture.proposalRef
    });

    // Then
    expect(response.status).toBe(201);
    const review = await readJsonObject(response);
    expect(stringField(review, "reviewId")).toMatch(/^[0-9a-f]{64}$/);
    expect(stringField(review, "projectId")).toBe("project-a");
    expect(stringField(review, "repositoryId")).toBe("source");
    expect(stringField(review, "expectedProtectedHead")).toBe(fixture.protectedHead);
    expect(stringField(review, "candidateCommit")).toMatch(/^[0-9a-f]{40}$/);
    expect(stringField(review, "candidateTree")).toMatch(/^[0-9a-f]{40}$/);
    expect(stringField(review, "policyRevision")).toBe("policy-1");
    expect(stringField(review, "requiredReviewRevision")).toBe("review-1");
    expect(stringField(review, "requiredJobSetRevision")).toBe("jobs-1");
    expect(stringArrayField(review, "requiredReviewerIds")).toEqual(["docs-reviewer", "reviewer-a"]);
    expect(objectArrayField(review, "changes")).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "renamed", oldPath: "README.md", newPath: "docs/README.md" }),
      expect.objectContaining({ status: "deleted", oldPath: "obsolete.txt" }),
      expect.objectContaining({ status: "added", newPath: "added.txt" }),
      expect.objectContaining({ status: "modified", newPath: "mode.sh", oldMode: "100644", newMode: "100755" }),
      expect.objectContaining({ status: "modified", newPath: "documentation", newMode: "120000", newSymlinkTarget: "docs/README.md" })
    ]));
    expect(stringField(review, "patch")).toContain("diff --git a/README.md b/docs/README.md");
    expect(stringField(review, "patch")).toContain("deleted file mode 100644");
    expect(await refValue(fixture.repositoryPath, "refs/heads/main")).toBe(fixture.protectedHead);
  });

  it("denies workspace, read-only CI, and foreign-Project identities", async () => {
    // Given
    const fixture = await startFixture();
    const requestBody = { protectedRef: "refs/heads/main", proposalRef: fixture.proposalRef };

    // When
    const writer = await fixture.request("writer-a", "POST", reviewPath(), requestBody);
    const ci = await fixture.request("ci-a", "POST", reviewPath(), requestBody);
    const foreign = await fixture.request("reviewer-b-user", "POST", reviewPath(), requestBody);

    // Then
    expect(writer.status).toBe(403);
    expect(ci.status).toBe(403);
    expect(foreign.status).toBe(404);
    expect(await refValue(fixture.repositoryPath, "refs/heads/main")).toBe(fixture.protectedHead);
  });
});

async function startFixture(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  return fixture;
}
