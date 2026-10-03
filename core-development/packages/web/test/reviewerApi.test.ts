import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { readJsonObject } from "../../native-git/test/nativeGitReviewHarness.js";
import {
  authenticatedSession,
  reviewerWebFixture,
  type WebFixture
} from "./webHarness.js";

const fixtures: WebFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("DIM reviewer web API", () => {
  it("serves only the packaged reviewer application with a same-origin CSP", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const [page, script, coordinator, patchPosition, missing, traversal] = await Promise.all([
      fetch(`${fixture.baseUrl}/`),
      fetch(`${fixture.baseUrl}/assets/app.js`),
      fetch(`${fixture.baseUrl}/assets/operation-coordinator.js`),
      fetch(`${fixture.baseUrl}/assets/patch-position.js`),
      fetch(`${fixture.baseUrl}/assets/not-shipped.js`),
      fetch(`${fixture.baseUrl}/assets/%2e%2e/src/server.ts`)
    ]);

    // Then
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );
    expect(await page.text()).toContain('<script src="/assets/app.js" type="module"></script>');
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(coordinator.status).toBe(200);
    expect(coordinator.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(patchPosition.status).toBe(200);
    expect(patchPosition.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(missing.status).toBe(401);
    expect(traversal.status).toBe(401);
  });

  it("logs in without exposing credentials and returns a hardened session", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const response = await fixture.login();

    // Then
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    expect(response.headers.get("set-cookie")).toMatch(/^dim_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict$/);
    expect(await readJsonObject(response)).toEqual({
      authenticated: true,
      projectId: "project-a",
      repositoryIds: ["source"],
      reviewerId: "reviewer-a",
      csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]+$/)
    });
    expect(await readFile(fixture.configPath, "utf8")).not.toContain("local-reviewer-password");
  });

  it("marks the session cookie Secure for an HTTPS public origin", async () => {
    // Given
    const fixture = await reviewerWebFixture({ secureOrigin: true });
    fixtures.push(fixture);

    // When
    const response = await fixture.login();

    // Then
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toMatch(/; HttpOnly; SameSite=Strict; Secure$/);
  });

  it("returns only whitelisted review evidence for its attested scope", async () => {
    // Given
    const fixture = await startFixture();
    const { cookie } = await authenticatedSession(fixture);

    // When
    const response = await fetch(`${fixture.baseUrl}/v1/projects/project-a/repositories/source/reviews/${fixture.reviewId}`, {
      headers: { Cookie: cookie }
    });

    // Then
    expect(response.status).toBe(200);
    const body = await readJsonObject(response);
    expect(body).toMatchObject({
      projectId: "project-a",
      repositoryId: "source",
      reviewId: fixture.reviewId,
      status: "pending",
      patch: expect.stringContaining("diff --git")
    });
    const serialized = JSON.stringify(body);
    for (const forbidden of ["patchBytes", "writerUsername", "reviewerUsername", "reporterUsername", "reviewer-a-user", "reviewer-a-secret"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("masks foreign scope and rejects tampered or generic proxy paths", async () => {
    // Given
    const fixture = await startFixture();
    const { cookie } = await authenticatedSession(fixture);
    const paths = [
      `/v1/projects/project-b/repositories/source/reviews/${fixture.reviewId}`,
      `/v1/projects/project-a/repositories/foreign/reviews/${fixture.reviewId}`,
      `/v1/projects/project-a/repositories/source/reviews/${fixture.reviewId}/approvals`,
      `/v1/projects/project-a/repositories/source/reviews/${fixture.reviewId}%2fapprovals`,
      "/v1/identity"
    ];

    // When
    const responses = await Promise.all(paths.map((path) => fetch(`${fixture.baseUrl}${path}`, { headers: { Cookie: cookie }, redirect: "manual" })));

    // Then
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
  });

  it("requires exact Origin and synchronizer CSRF for review creation and logout", async () => {
    // Given
    const fixture = await startFixture();
    const { cookie, csrfToken } = await authenticatedSession(fixture);
    const body = JSON.stringify({ protectedRef: "refs/heads/main", proposalRef: fixture.native.proposalRef });
    const request = (origin: string, token: string) => fetch(`${fixture.baseUrl}/v1/projects/project-a/repositories/source/reviews`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: origin, "X-DIM-CSRF": token },
      body,
      redirect: "manual"
    });

    // When
    const wrongOrigin = await request("http://127.0.0.1:1", csrfToken);
    const wrongToken = await request(fixture.origin, "wrong-token");
    const accepted = await request(fixture.origin, csrfToken);

    // Then
    expect(wrongOrigin.status).toBe(403);
    expect(wrongToken.status).toBe(403);
    expect(accepted.status).toBe(201);
    const logout = await fetch(`${fixture.baseUrl}/v1/session`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: fixture.origin, "X-DIM-CSRF": csrfToken }
    });
    expect(logout.status).toBe(204);
    const replay = await request(fixture.origin, csrfToken);
    expect(replay.status).toBe(401);
  });

  it("rejects wrong credentials and idle or absolute expired sessions", async () => {
    // Given
    const fixture = await startFixture();

    // When
    const wrong = await fixture.login({ password: "incorrect-password" });
    const first = await authenticatedSession(fixture);
    fixture.now.value += 10_001;
    const idleExpired = await getSession(fixture, first.cookie);
    const second = await authenticatedSession(fixture);
    fixture.now.value += 9_000;
    expect((await getSession(fixture, second.cookie)).status).toBe(200);
    fixture.now.value += 21_001;
    const absoluteExpired = await getSession(fixture, second.cookie);

    // Then
    expect(wrong.status).toBe(401);
    expect(await readJsonObject(wrong)).toEqual({ error: "authentication failed" });
    expect(idleExpired.status).toBe(401);
    expect(absoluteExpired.status).toBe(401);
  });
});

async function startFixture(): Promise<WebFixture> {
  const fixture = await reviewerWebFixture();
  fixtures.push(fixture);
  return fixture;
}

function getSession(fixture: WebFixture, cookie: string): Promise<Response> {
  return fetch(`${fixture.baseUrl}/v1/session`, { headers: { Cookie: cookie } });
}
