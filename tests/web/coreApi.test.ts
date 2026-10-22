import { readFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { authenticatedSession, webFixture, type WebFixture, WEB_PASSWORD } from "./webHarness.js";
const fixtures: WebFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.close())); });
async function fixture(options: Parameters<typeof webFixture>[0] = {}) { const value = await webFixture(options); fixtures.push(value); return value; }
it("serves only shipped console assets with a same-origin CSP", async () => {
  const f = await fixture();
  const page = await fetch(f.baseUrl);
  expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  expect(await page.text()).toContain('<script src="/assets/app.js" type="module"></script>');
  for (const path of ["app.js", "session-data.js", "operation-coordinator.js", "navigation-broker.js", "workspace-hosts.js", "workspace-create.js", "workspace-row.js", "workspace-ui.js", "feature-ui.js"]) {
    const asset = await fetch(`${f.baseUrl}/assets/${path}`);
    expect(asset.status).toBe(200); expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  }
  for (const path of ["/assets/not-shipped.js", "/assets/%2e%2e/src/server.ts"]) expect((await fetch(f.baseUrl + path)).status).toBe(401);
});
it("returns a credential-free hardened session and uses Secure cookies for HTTPS", async () => {
  const f = await fixture();
  const response = await f.login();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toMatch(/^dim_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict$/);
  expect(await response.json()).toEqual({ authenticated: true, csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]+$/), roles: ["read", "operator"], capabilities: { operations: true } });
  expect(await readFile(f.configPath, "utf8")).not.toContain(WEB_PASSWORD);
  const https = await fixture({ secureOrigin: true });
  expect((await https.login()).headers.get("set-cookie")).toMatch(/; Secure$/);
});
it("requires exact Origin and CSRF for logout, rejects duplicate cookies, and removes the session after logout", async () => {
  const f = await fixture(), session = await authenticatedSession(f);
  for (const headers of [ { Cookie: session.cookie, Origin: "https://attacker.invalid", "X-DIM-CSRF": session.csrfToken },
    { Cookie: session.cookie, Origin: f.origin, "X-DIM-CSRF": "wrong" }]) {
    expect((await fetch(f.baseUrl + "/v1/session", { method: "DELETE", headers })).status).toBe(403);
  }
  expect((await fetch(f.baseUrl + "/v1/session", { headers: { Cookie: `${session.cookie}; ${session.cookie}` } })).status).toBe(401);
  const logout = await fetch(f.baseUrl + "/v1/session", { method: "DELETE", headers: { Cookie: session.cookie, Origin: f.origin, "X-DIM-CSRF": session.csrfToken } });
  expect(logout.status).toBe(204); expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await fetch(f.baseUrl + "/v1/session", { headers: { Cookie: session.cookie } })).status).toBe(401);
});
