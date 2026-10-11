import { afterEach, describe, expect, it } from "vitest";
import {
  nativeGitReviewFixture,
  readJsonObject,
  type ReviewFixture
} from "./nativeGitReviewHarness.js";

const fixtures: ReviewFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("DIM native Git own identity", () => {
  it("returns the authenticated reviewer's exact scope", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const response = await fixture.request("reviewer-a-user", "GET", "/v1/identity");

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await readJsonObject(response)).toEqual({
      role: "reviewer",
      projectId: "project-a",
      repositoryIds: ["source"],
      reviewerId: "reviewer-a"
    });
  });

  it("returns only a foreign reviewer's own Project scope", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const response = await fixture.request("reviewer-b-user", "GET", "/v1/identity");

    // Then
    expect(response.status).toBe(200);
    expect(await readJsonObject(response)).toEqual({
      role: "reviewer",
      projectId: "project-b",
      repositoryIds: ["source"],
      reviewerId: "reviewer-b"
    });
  });

  it("does not elevate an administrator to reviewer or promoter", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const response = await fixture.request("admin-a", "GET", "/v1/identity");

    // Then
    expect(response.status).toBe(200);
    expect(await readJsonObject(response)).toEqual({
      role: "administrator",
      projectId: "project-a",
      repositoryIds: ["source"]
    });
  });

  it("omits a writer's credential and workspace binding", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const response = await fixture.request("writer-a", "GET", "/v1/identity");

    // Then
    expect(response.status).toBe(200);
    expect(await readJsonObject(response)).toEqual({
      role: "writer",
      projectId: "project-a",
      repositoryIds: ["source"]
    });
  });

  it("returns a promoter role without reviewer authority", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const response = await fixture.request("promoter-a", "GET", "/v1/identity");

    // Then
    expect(response.status).toBe(200);
    expect(await readJsonObject(response)).toEqual({
      role: "promoter",
      projectId: "project-a",
      repositoryIds: ["source"]
    });
  });

  it("challenges an unauthenticated request without an identity body", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const response = await fetch(`${fixture.baseUrl()}/v1/identity`);

    // Then
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="DIM Git"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("challenges an invalid credential without an identity body", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const response = await fetch(`${fixture.baseUrl()}/v1/identity`, {
      headers: { Authorization: `Basic ${Buffer.from("reviewer-a-user:incorrect-password").toString("base64")}` }
    });

    // Then
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="DIM Git"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("rejects an arbitrary identity lookup query", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const response = await fixture.request("reviewer-a-user", "GET", "/v1/identity?username=reviewer-b-user");

    // Then
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});

async function startFixture(): Promise<ReviewFixture> {
  const fixture = await nativeGitReviewFixture();
  fixtures.push(fixture);
  return fixture;
}
