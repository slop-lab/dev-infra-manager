import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  objectArrayField,
  readJsonObject,
  reviewPath,
  stringField
} from "../../native-git/test/nativeGitReviewHarness.js";
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

  it("approves the exact review and revokes only the authenticated reviewer's approval", async () => {
    // Given
    const fixture = await startFixture();
    const { cookie, csrfToken } = await authenticatedSession(fixture);
    const actionPath = `${fixture.baseUrl}/v1/projects/project-a/repositories/source/reviews/${fixture.reviewId}`;
    const mutate = (suffix: string, body: object = {}) => fetch(`${actionPath}/${suffix}`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        Origin: fixture.origin,
        "X-DIM-CSRF": csrfToken
      },
      body: JSON.stringify(body)
    });
    const foreignApprovalResponse = await fixture.native.request(
      "docs-reviewer-user",
      "POST",
      reviewPath(`/${fixture.reviewId}/approvals`),
      {}
    );
    const foreignApprovalId = stringField(await readJsonObject(foreignApprovalResponse), "approvalId");

    // When
    const foreignRevocation = await mutate("revocations", { approvalId: foreignApprovalId });
    const emptyForeignRevocation = await mutate("revocations");
    const approval = await mutate("approvals");
    const approvedReview = await readJsonObject(approval);
    const ownApproval = objectArrayField(approvedReview, "approvals")
      .find((entry) => entry.reviewerId === "reviewer-a");
    if (ownApproval === undefined) throw new Error("expected authenticated reviewer approval");
    const revocation = await mutate("revocations");
    const revokedReview = await readJsonObject(revocation);

    // Then
    expect(foreignRevocation.status).toBe(400);
    expect(emptyForeignRevocation.status).toBe(409);
    expect(await readJsonObject(emptyForeignRevocation)).toEqual({ error: "no active approval to revoke" });
    expect(approval.status).toBe(200);
    expect(approvedReview).toMatchObject({ reviewId: fixture.reviewId, status: "approved" });
    expect(revocation.status).toBe(200);
    expect(revokedReview).toMatchObject({ reviewId: fixture.reviewId, status: "revoked" });
    expect(objectArrayField(revokedReview, "revocations")).toEqual(expect.arrayContaining([
      expect.objectContaining({ approvalId: stringField(ownApproval, "approvalId") })
    ]));
    expect(objectArrayField(revokedReview, "revocations")).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ approvalId: foreignApprovalId })
    ]));
  });

  it("denies unauthenticated, foreign-scope, wrong-Origin, wrong-CSRF, and stale approval", async () => {
    // Given
    const fixture = await startFixture();
    const { cookie, csrfToken } = await authenticatedSession(fixture);
    const actionPath = `${fixture.baseUrl}/v1/projects/project-a/repositories/source/reviews/${fixture.reviewId}/approvals`;
    const request = (path: string, origin: string, token: string, includeCookie = true) => fetch(path, {
      method: "POST",
      headers: {
        ...(includeCookie ? { Cookie: cookie } : {}),
        "Content-Type": "application/json",
        Origin: origin,
        "X-DIM-CSRF": token
      },
      body: "{}"
    });

    // When
    const unauthenticated = await request(actionPath, fixture.origin, csrfToken, false);
    const foreign = await request(actionPath.replace("project-a", "project-b"), fixture.origin, csrfToken);
    const wrongOrigin = await request(actionPath, "http://127.0.0.1:1", csrfToken);
    const wrongCsrf = await request(actionPath, fixture.origin, "wrong-token");
    await writeFile(join(fixture.native.clone, "changed-after-review.txt"), "changed\n");
    await fixture.native.git(fixture.native.clone, ["add", "changed-after-review.txt"]);
    await fixture.native.git(fixture.native.clone, ["commit", "-m", "change after review"]);
    await fixture.native.git(fixture.native.clone, ["push", "origin", `HEAD:${fixture.native.proposalRef}`]);
    const stale = await request(actionPath, fixture.origin, csrfToken);

    // Then
    expect([unauthenticated.status, foreign.status, wrongOrigin.status, wrongCsrf.status, stale.status])
      .toEqual([401, 404, 403, 403, 409]);
    expect(await readJsonObject(stale)).toEqual({ error: "review is stale" });
    expect(objectArrayField(await readJsonObject(await fetch(
      `${fixture.baseUrl}/v1/projects/project-a/repositories/source/reviews/${fixture.reviewId}`,
      { headers: { Cookie: cookie } }
    )), "approvals")).toEqual([]);
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
