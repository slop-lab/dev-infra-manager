import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { loadWebConfig } from "../../packages/web/core/src/config.js";
import { authenticatedSession, webFixture, WEB_USERNAME, WEB_PASSWORD, type WebFixture } from "./webHarness.js";
const fixtures: WebFixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.close())); });
async function setup(admin = true) {
  const f = await webFixture({ accounts: [WEB_USERNAME, "target"], operatorRoles: admin ? ["read", "operator", "account-admin"] : ["read", "operator"] }); fixtures.push(f);
  const session = await authenticatedSession(f);
  const headers = { Cookie: session.cookie, Origin: f.origin, "X-DIM-CSRF": session.csrfToken, "Content-Type": "application/json" };
  return { f, headers, mutate: (body: object, overrides: Record<string, string> = {}) => fetch(f.baseUrl + "/v1/accounts", { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(body) }) };
}
it("requires dedicated administration authority, exact Origin, CSRF and current-password verification", async () => {
  const ordinary = await setup(false);
  expect((await fetch(ordinary.f.baseUrl + "/v1/accounts", { headers: ordinary.headers })).status).toBe(403);
  expect((await ordinary.mutate({ operation: "set-roles", username: WEB_USERNAME, roles: ["account-admin"], currentPassword: WEB_PASSWORD })).status).toBe(403);
  const { f, headers, mutate } = await setup(); const before = await readFile(f.configPath, "utf8");
  const body = { operation: "set-roles", username: "target", roles: ["read", "reviewer"], currentPassword: WEB_PASSWORD };
  expect((await mutate(body, { Origin: "https://attacker.invalid" })).status).toBe(403);
  expect((await mutate(body, { "X-DIM-CSRF": "wrong" })).status).toBe(403);
  expect((await mutate({ ...body, currentPassword: "wrong" })).status).toBe(403);
  const list = await (await fetch(f.baseUrl + "/v1/accounts", { headers })).json();
  expect(list).toEqual({ accounts: [{ username: WEB_USERNAME, roles: ["read", "operator", "account-admin"] }, { username: "target", roles: ["read"] }] });
  expect(JSON.stringify(list)).not.toContain("scrypt");
  expect(await readFile(f.configPath, "utf8")).toBe(before);
});
it("applies role changes live, revokes the target session, and preserves the administrator session and password", async () => {
  const { f, headers, mutate } = await setup(); const original = await loadWebConfig(f.configPath);
  const target = await f.login({ username: "target" }); const cookie = target.headers.get("set-cookie")!.split(";", 1)[0]!;
  const response = await mutate({ operation: "set-roles", username: "target", roles: ["read", "reviewer"], currentPassword: WEB_PASSWORD });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ signInRequired: false });
  expect((await fetch(f.baseUrl + "/v1/session", { headers: { Cookie: cookie } })).status).toBe(401);
  expect((await fetch(f.baseUrl + "/v1/session", { headers })).status).toBe(200);
  expect(await (await f.login({ username: "target" })).json()).toMatchObject({ roles: ["read", "reviewer"] });
  const updated = await loadWebConfig(f.configPath);
  expect(updated.accounts.map((account) => account.passwordHash)).toEqual(original.accounts.map((account) => account.passwordHash));
  expect(updated.operations).toEqual(original.operations);
});
it("resets a password live and invalidates old target credentials without affecting the admin", async () => {
  const { f, headers, mutate } = await setup();
  const target = await f.login({ username: "target" }); const cookie = target.headers.get("set-cookie")!.split(";", 1)[0]!;
  const response = await mutate({ operation: "reset-password", username: "target", currentPassword: WEB_PASSWORD });
  expect(response.status).toBe(200); const result = await response.json(); expect(result.password).toBeTypeOf("string");
  expect((await readFile(f.configPath, "utf8"))).not.toContain(result.password);
  expect((await fetch(f.baseUrl + "/v1/session", { headers: { Cookie: cookie } })).status).toBe(401);
  expect((await f.login({ username: "target" })).status).toBe(401);
  expect((await f.login({ username: "target", password: result.password })).status).toBe(201);
  expect((await fetch(f.baseUrl + "/v1/accounts", { headers })).status).toBe(200);
});
it("prevents last-admin lockout and does not leak private server paths on rejected mutations", async () => {
  const { f, mutate } = await setup(); const before = await readFile(f.configPath, "utf8");
  for (const change of [{ operation: "remove", username: WEB_USERNAME }, { operation: "set-roles", username: WEB_USERNAME, roles: ["read", "operator"] }]) {
    const response = await mutate({ ...change, currentPassword: WEB_PASSWORD }); expect(response.status).toBe(409);
    const result = await response.json(); expect(result.error).toMatch(/last account administrator/); expect(JSON.stringify(result)).not.toContain(f.configPath);
  }
  expect(await readFile(f.configPath, "utf8")).toBe(before);
});
it("supports adding a new administrator and relinquishing one's own authority without a restart", async () => {
  const { f, headers, mutate } = await setup();
  const response = await mutate({ operation: "add", username: "owner2", roles: ["read", "account-admin"], currentPassword: WEB_PASSWORD });
  const created = await response.json(); expect(response.status).toBe(200); expect(created.password).toBeTypeOf("string");
  const relinquish = await mutate({ operation: "set-roles", username: WEB_USERNAME, roles: ["read"], currentPassword: WEB_PASSWORD });
  expect(await relinquish.json()).toMatchObject({ signInRequired: true });
  expect((await fetch(f.baseUrl + "/v1/session", { headers })).status).toBe(401);
  const login = await f.login({ username: "owner2", password: created.password }); expect(login.status).toBe(201);
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  expect((await fetch(f.baseUrl + "/v1/accounts", { headers: { Cookie: cookie } })).status).toBe(200);
});
it("revokes deleted accounts immediately and rejects login and malformed account mutations", async () => {
  const { f, mutate } = await setup();
  const target = await f.login({ username: "target" }); const cookie = target.headers.get("set-cookie")!.split(";", 1)[0]!;
  expect((await mutate({ operation: "remove", username: "target", currentPassword: WEB_PASSWORD })).status).toBe(200);
  expect((await fetch(f.baseUrl + "/v1/session", { headers: { Cookie: cookie } })).status).toBe(401);
  expect((await f.login({ username: "target" })).status).toBe(401);
  expect((await mutate({ operation: "add", username: "bad", roles: ["root"], currentPassword: WEB_PASSWORD })).status).toBe(400);
  expect((await mutate({ operation: "reset-password", username: WEB_USERNAME, roles: ["read"], currentPassword: WEB_PASSWORD })).status).toBe(400);
});
it("rate-limits password confirmation through the shared bounded login authenticator", async () => {
  const { f, mutate } = await setup(); const before = await readFile(f.configPath, "utf8");
  for (let attempt = 0; attempt < 4; attempt++) expect((await mutate({ operation: "remove", username: "target", currentPassword: "wrong" })).status).toBe(403);
  const limited = await mutate({ operation: "remove", username: "target", currentPassword: "wrong" });
  expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBe("1");
  expect(await readFile(f.configPath, "utf8")).toBe(before);
});

it("rejects an administrator removed while its request body is still arriving", async () => {
  const { f, headers, mutate } = await setup();
  expect((await mutate({ operation: "set-roles", username: "target", roles: ["read", "account-admin"], currentPassword: WEB_PASSWORD })).status).toBe(200);
  const login = await f.login({ username: "target" }); const body = await login.json();
  const targetHeaders = { ...headers, Cookie: login.headers.get("set-cookie")!.split(";", 1)[0]!, "X-DIM-CSRF": body.csrfToken };
  const started = new Promise<void>((resolve) => f.service.server.once("request", () => resolve()));
  let finish!: () => void;
  const response = new Promise<number>((resolve, reject) => {
    const incoming = request(f.baseUrl + "/v1/accounts", { method: "POST", headers }, (reply) => { reply.resume(); reply.on("end", () => resolve(reply.statusCode!)); });
    incoming.on("error", reject); incoming.write('{"operation":"remove",');
    finish = () => incoming.end(JSON.stringify({ username: "target", currentPassword: WEB_PASSWORD }).slice(1));
  });
  await started;
  try {
    const revoked = await fetch(f.baseUrl + "/v1/accounts", { method: "POST", headers: targetHeaders, body: JSON.stringify({ operation: "remove", username: WEB_USERNAME, currentPassword: WEB_PASSWORD }) });
    expect(revoked.status).toBe(200);
  } finally { finish(); }
  expect(await response).toBe(403);
});
