import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { refValue } from "./nativeGitHarness.js";
import {
  nativeGitReviewFixture,
  objectArrayField,
  readJsonObject,
  reviewPath,
  stringArrayField,
  stringField,
  type JsonObject,
  type ReviewFixture
} from "./nativeGitReviewHarness.js";

const fixtures: ReviewFixture[] = [];
const run = promisify(execFile);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("DIM native Git immutable human approval", () => {
  it("requires every path owner to approve the whole exact candidate and permits revocation", async () => {
    // Given
    const fixture = await startFixture();
    const reviewId = await createReview(fixture);

    // When
    const firstResponse = await fixture.request("reviewer-a-user", "POST", reviewPath(`/${reviewId}/approvals`), {});
    const firstApproval = await readJsonObject(firstResponse);
    const pending = await getReview(fixture, reviewId);
    const secondResponse = await fixture.request("docs-reviewer-user", "POST", reviewPath(`/${reviewId}/approvals`), {});
    const secondApproval = await readJsonObject(secondResponse);
    const approved = await getReview(fixture, reviewId);
    const revokedResponse = await fixture.request("admin-a", "POST", reviewPath(`/${reviewId}/revocations`), {
      approvalId: stringField(secondApproval, "approvalId")
    });
    const revoked = await getReview(fixture, reviewId);

    // Then
    expect(firstResponse.status).toBe(201);
    expect(stringField(firstApproval, "reviewerId")).toBe("reviewer-a");
    expect(stringField(pending, "status")).toBe("pending");
    expect(secondResponse.status).toBe(201);
    expect(stringField(approved, "status")).toBe("approved");
    expect(revokedResponse.status).toBe(201);
    expect(stringField(revoked, "status")).toBe("revoked");
    expect(await refValue(fixture.repositoryPath, "refs/heads/main")).toBe(fixture.protectedHead);
  });

  it("denies self, writer, read-only CI, administrator, and foreign approval", async () => {
    // Given
    const fixture = await startFixture();
    const reviewId = await createReview(fixture);
    const path = reviewPath(`/${reviewId}/approvals`);

    // When
    const writer = await fixture.request("writer-a", "POST", path, {});
    const reader = await fixture.request("ci-a", "POST", path, {});
    const ci = await fixture.request("ordinary-results", "POST", path, {});
    const administrator = await fixture.request("admin-a", "POST", path, {});
    const foreign = await fixture.request("reviewer-b-user", "POST", path, {});

    // Then
    expect(writer.status).toBe(403);
    expect(reader.status).toBe(403);
    expect(ci.status).toBe(403);
    expect(administrator.status).toBe(403);
    expect(foreign.status).toBe(404);
    expect(objectArrayField(await getReview(fixture, reviewId), "approvals")).toEqual([]);
  });

  it("marks approval stale after proposal head and tree move", async () => {
    // Given
    const fixture = await startFixture();
    const reviewId = await createAndFullyApprove(fixture);
    await writeFileCandidate(fixture, "changed-after-review.txt", "changed\n");

    // When
    await fixture.git(fixture.clone, ["push", "origin", `HEAD:${fixture.proposalRef}`]);
    const status = await getReview(fixture, reviewId);

    // Then
    expect(stringField(status, "status")).toBe("stale");
    expect(stringArrayField(status, "staleReasons")).toEqual(expect.arrayContaining(["candidate-commit-changed", "candidate-tree-changed"]));
    expect(await refValue(fixture.repositoryPath, "refs/heads/main")).toBe(fixture.protectedHead);
  });

  it("persists approval across restart but invalidates changed review policy", async () => {
    // Given
    const fixture = await startFixture();
    const reviewId = await createAndFullyApprove(fixture);

    // When
    await fixture.restart();
    const afterRestart = await getReview(fixture, reviewId);
    const changedPolicy = fixture.configWithPolicyRevision("policy-2");
    await fixture.restart(changedPolicy);
    const afterPolicyChange = await getReview(fixture, reviewId);

    // Then
    expect(stringField(afterRestart, "status")).toBe("approved");
    expect(stringField(afterPolicyChange, "status")).toBe("stale");
    expect(stringArrayField(afterPolicyChange, "staleReasons")).toContain("policy-changed");
    expect(await refValue(fixture.repositoryPath, "refs/heads/main")).toBe(fixture.protectedHead);
  });

  it("invalidates approval when a bound writer or reviewer identity changes", async () => {
    // Given
    const fixture = await startFixture();
    const reviewId = await createAndFullyApprove(fixture);
    const changedWriter = fixture.configWithIdentityUsername("writer-a", "writer-a-replaced");

    // When
    await fixture.restart(changedWriter);
    const writerDrift = await getReview(fixture, reviewId);
    const changedReviewer = fixture.configWithIdentityUsername("reviewer-a-user", "reviewer-a-replaced");
    await fixture.restart(changedReviewer);
    const reviewerDrift = await getReview(fixture, reviewId);

    // Then
    expect(stringField(writerDrift, "status")).toBe("stale");
    expect(stringArrayField(writerDrift, "staleReasons")).toContain("writer-identity-changed");
    expect(stringField(reviewerDrift, "status")).toBe("stale");
    expect(stringArrayField(reviewerDrift, "staleReasons")).toContain("reviewer-identity-changed");
  });

  it("rejects a second process before it can race revocation with promotion", async () => {
    // Given
    const fixture = await startFixture();
    const script = `import { createNativeGitServer } from "../core/packages/native-git/src/index.ts";
const server = createNativeGitServer(JSON.parse(process.env.DIM_TEST_CONFIG));
try { await server.listen(); await server.close(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 23; }`;

    // When
    const attempt = run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DIM_TEST_CONFIG: JSON.stringify({ ...fixture.config, port: 0 }) }
    });

    // Then
    await expect(attempt).rejects.toMatchObject({ code: 23, stderr: expect.stringMatching(/storage root.*active server/i) });
  });
});

async function startFixture(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  return fixture;
}

async function createReview(fixture: ReviewFixture): Promise<string> {
  const response = await fixture.request("reviewer-a-user", "POST", reviewPath(), {
    protectedRef: "refs/heads/main",
    proposalRef: fixture.proposalRef
  });
  expect(response.status).toBe(201);
  const review = await readJsonObject(response);
  const reviewId = stringField(review, "reviewId");
  expect(reviewId).toMatch(/^[0-9a-f]{64}$/);
  return reviewId;
}

async function createAndFullyApprove(fixture: ReviewFixture): Promise<string> {
  const reviewId = await createReview(fixture);
  const first = await fixture.request("reviewer-a-user", "POST", reviewPath(`/${reviewId}/approvals`), {});
  const second = await fixture.request("docs-reviewer-user", "POST", reviewPath(`/${reviewId}/approvals`), {});
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(stringField(await getReview(fixture, reviewId), "status")).toBe("approved");
  return reviewId;
}

async function getReview(fixture: ReviewFixture, reviewId: string): Promise<JsonObject> {
  const response = await fixture.request("admin-a", "GET", reviewPath(`/${reviewId}`));
  expect(response.status).toBe(200);
  return readJsonObject(response);
}

async function writeFileCandidate(fixture: ReviewFixture, path: string, content: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${fixture.clone}/${path}`, content);
  await fixture.git(fixture.clone, ["add", path]);
  await fixture.git(fixture.clone, ["commit", "-m", path]);
}
