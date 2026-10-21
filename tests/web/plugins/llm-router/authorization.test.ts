import { expect, it } from "vitest";
import { llmWebFixture } from "./fixture.js";
import { readFile, writeFile } from "node:fs/promises";
import { loadWebPlugins } from "../../../../packages/web/core/src/plugins.js";
import { fileURLToPath } from "node:url";
it("rejects ancestor-only packages outside the selected Web runtime", async () => {
  const home = fileURLToPath(new URL("./", import.meta.url));
  await expect(loadWebPlugins([{ package: "@slop-lab/dim-web-plugin-llm-router" }], home)).rejects.toThrow();
});
it("loads installed feature packages with role-filtered discovery, exact Origin/CSRF and server-only credentials", async () => {
  const fixture = await llmWebFixture();
  try {
    const path = fixture.origin + "/v1/extensions/llm-router/operations/";
    expect((await fetch(path + "projects", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const observer = await fixture.login("observer"), operator = await fixture.login();
    const discovery = await fetch(fixture.origin + "/v1/extensions", { headers: observer });
    const features = await discovery.json() as Array<{ id: string; configured: boolean; operations: Array<{ name: string; access: string }> }>;
    const llm = features.find(({ id }) => id === "llm-router")!;
    expect(llm.configured).toBe(true); expect(llm.operations.every(({ access }) => access === "read")).toBe(true);
    expect(features.find(({ id }) => id === "native-git")).toMatchObject({ configured: false, operations: [] });
    const post = (name: string, headers: Record<string,string>, input: unknown = {}) => fetch(path + name, { method: "POST", headers, body: JSON.stringify(input) });
    expect((await post("project.state", observer, { projectId: "example", action: "disable" })).status).toBe(403);
    expect((await post("projects", { ...operator, "x-dim-csrf": "wrong" })).status).toBe(403);
    expect((await post("projects", { ...operator, origin: "http://localhost:9081" })).status).toBe(403);
    expect((await post("project.create", operator, { projectId: "bad", routeId: "default", keyFile: "/tmp/attacker" })).status).toBe(400);
    const response = await post("projects", observer); expect(response.status).toBe(200); expect(await response.json()).toMatchObject([{ id: "example" }]);
    expect((await post("project.state", operator, { projectId: "example", action: "pause" })).status).toBe(200);
    expect(fixture.router.ledger.project("example").paused).toBe(true);
    const metadata = JSON.stringify(features) + JSON.stringify(await (await post("overview", observer)).json());
    for (const secret of [fixture.operatorKey, fixture.connectionFile, fixture.keyFile, "keyFile", "token_hash"]) expect(metadata).not.toContain(secret);
    expect((await fetch(fixture.origin + "/v1/extensions/llm-router/assets/panel.js", { headers: observer })).status).toBe(200);
    expect((await fetch(fixture.origin + "/v1/extensions/llm-router/assets/config.json", { headers: observer })).status).toBe(404);
    expect(fixture.inferenceRequests()).toBe(0);
  } finally { await fixture.close(); }
});
it("isolates an unavailable optional connection and reconnects only its configured private endpoint", async () => {
  const fixture = await llmWebFixture();
  try {
    const before = await readFile(fixture.connectionFile, "utf8");
    await writeFile(fixture.connectionFile, JSON.stringify({ ...JSON.parse(before), endpoint: "http://127.0.0.1:1" }), { mode: 0o600 });
    await fixture.restartWeb();
    const headers = await fixture.login("observer");
    const response = await fetch(fixture.origin + "/v1/extensions", { headers });
    expect(await response.json()).toContainEqual(expect.objectContaining({ id: "llm-router", configured: true, status: "unavailable", operations: [] }));
    expect((await fetch(fixture.origin + "/v1/operations/status", { headers })).status).toBe(200);
    await writeFile(fixture.connectionFile, before, { mode: 0o600 });
    const url = fixture.origin + "/v1/extensions/llm-router/reconnect";
    expect((await fetch(url, { method: "POST", headers: { ...headers, "x-dim-csrf": "wrong" }, body: "{}" })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers, body: '{"connectionFile":"/tmp/untrusted"}' })).status).toBe(400);
    const connected = await fetch(url, { method: "POST", headers, body: "{}" });
    expect(connected.status).toBe(200);
    expect(await connected.json()).toMatchObject({ id: "llm-router", configured: true, status: "ready", operations: expect.arrayContaining([expect.objectContaining({ name: "projects", access: "read" })]) });
  } finally { await fixture.close(); }
});
