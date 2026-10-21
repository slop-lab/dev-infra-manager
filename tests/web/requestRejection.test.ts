import { afterEach, expect, it } from "vitest";
import { authenticatedSession, webFixture, type WebFixture, WEB_PASSWORD } from "./webHarness.js";
const fixtures: WebFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.close())); });
it("rejects wrong authentication and origin without returning private credentials", async () => {
  const f = await webFixture(); fixtures.push(f);
  const wrong = await f.login({ password: "wrong-password" });
  expect(wrong.status).toBe(401);
  const origin = await fetch(f.baseUrl + "/v1/session", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:9081" }, body: JSON.stringify({ username: "local-operator", password: WEB_PASSWORD }) });
  expect(origin.status).toBe(403);
  expect(await origin.json()).toEqual({ error: `Open this console at ${f.origin} and sign in again. The address must match the configured public URL.` });
  const session = await authenticatedSession(f);
  for (const path of ["/v1/projects/project-a/repositories/root/reviews", "/v1/operations/ci/jobs", "/v1/operations/execution/workers", "/v1/proxy"]) {
    const response = await fetch(f.baseUrl + path, { headers: { Cookie: session.cookie } });
    expect(response.status).toBe(404); expect(await response.text()).not.toContain(WEB_PASSWORD);
  }
});
