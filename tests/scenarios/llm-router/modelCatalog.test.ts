import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { backendProfile, defaultLimits, parseConfig, parseModel } from "../../../packages/control-plane/plugins/llm-router/src/config.js";
import { discoverAccountModels } from "../../../packages/control-plane/plugins/llm-router/src/model-catalog.js";
import { createRouter } from "../../../packages/control-plane/plugins/llm-router/src/server.js";
import { invokeRouterOperation } from "../../../packages/control-plane/plugins/llm-router/src/operations.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const root = await mkdtemp(join(tmpdir(), "dim-model-catalog-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const upstream = createServer(handle); await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); });
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("missing address");
  const endpoint = `http://127.0.0.1:${address.port}`, keyFile = join(root, "key"); await writeFile(keyFile, "private-key", { mode: 0o600 });
  const config = parseConfig({ schemaVersion: 3, stateDirectory: join(root, "state"), hostIssuers: [], listen: { host: "127.0.0.1", port: 8318 }, backend: backendProfile,
    accounts: [{ id: "one", reference: "One account", endpoint, keyFile }], routes: [{ id: "default", accountId: "one", models: "all" }], limits: defaultLimits });
  const router = await createRouter(config); cleanup.push(() => router.close()); await new Promise<void>((resolve) => router.server.listen(0, "127.0.0.1", resolve));
  const selected = router.server.address(); if (!selected || typeof selected === "string") throw new Error("missing router address");
  router.ledger.createProject("demo", { allowedRoutes: ["default"], limits: defaultLimits, captureMode: "metadata", tokenMode: "observe" });
  const token = router.ledger.issue({ id: "workspace", name: "workspace" }, "default", "demo");
  return { config, router, endpoint, origin: `http://127.0.0.1:${selected.port}`, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } };
}
it("discovers credential-scoped models, refreshes additions, rejects arbitrary models and fails closed", async () => {
  let ids = ["first"], discoveries = 0, failed = false;
  const fx = await fixture((request, response) => {
    expect(request.headers.authorization).toBe("Bearer private-key"); discoveries++;
    response.writeHead(failed ? 503 : 200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: ids.map((id) => ({ id, context_length: 200_000, max_output_tokens: 20_000 })) }));
  });
  expect((await fetch(fx.origin + "/v1/models")).status).toBe(401); expect(discoveries).toBe(0);
  const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const first = await fetch(fx.origin + "/v1/models", { headers: fx.headers }); expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ data: [{ id: "first", api: "responses", context: 200_000, output: 20_000 }] });
  ids = ["first", "second"];
  expect(await discoverAccountModels(fx.config, fx.config.accounts[0]!)).toHaveLength(1); expect(discoveries).toBe(1);
  clock.mockReturnValue(now + 30_001);
  expect(await discoverAccountModels(fx.config, fx.config.accounts[0]!)).toHaveLength(2); expect(discoveries).toBe(2);
  expect(await invokeRouterOperation(fx.config, fx.router.ledger, "overview", {})).toMatchObject({ routes: [{ models: "all" }] });
  expect(await invokeRouterOperation(fx.config, fx.router.ledger, "account.models", { accountId: "one" })).toHaveLength(2);
  expect((await fetch(fx.origin + "/v1/responses", { method: "POST", headers: fx.headers, body: JSON.stringify({ model: "not-in-account", input: [] }) })).status).toBe(403);
  expect(discoveries).toBe(2);
  failed = true; clock.mockReturnValue(now + 60_002);
  expect((await fetch(fx.origin + "/v1/models", { headers: fx.headers })).status).toBe(503);
});
it("discovers compatible API models with private provider keys and configures backend aliases", async () => {
  const fx = await fixture((request, response) => {
    expect(request.url).toBe("/v1/models"); expect(request.headers.authorization).toBe("Bearer provider-secret");
    response.end(JSON.stringify({ data: [{ id: "compatible-model" }] }));
  });
  const path = join(fx.config.stateDirectory, "managed-accounts/api"); await mkdir(path, { recursive: true });
  const file = join(path, "config.yaml");
  await writeFile(file, JSON.stringify({ "api-keys": { "openai-compatibility": [{ "base-url": fx.endpoint + "/v1", keys: [{ "api-key": "provider-secret" }], models: [] }] } }), { mode: 0o600 });
  const account = { ...fx.config.accounts[0]!, id: "api", provider: "openai" as const };
  const models = await discoverAccountModels(fx.config, account);
  expect(models).toEqual([{ id: "compatible-model", name: "compatible-model", api: "chat" }]);
  const worker = JSON.parse(await readFile(file, "utf8"));
  expect(worker["api-keys"]["openai-compatibility"][0].models).toEqual([{ name: "compatible-model", alias: "compatible-model" }]);
  expect(JSON.stringify(models)).not.toContain("provider-secret");
});
it("rejects duplicate catalog entries and unsupported wildcard policy", async () => {
  const fx = await fixture((_request, response) => response.end(JSON.stringify({ data: [{ id: "duplicate" }, { id: "duplicate" }] })));
  await expect(discoverAccountModels(fx.config, fx.config.accounts[0]!)).rejects.toThrow("duplicate");
  expect(() => parseConfig({ ...fx.config, routes: [{ ...fx.config.routes[0], models: "*" }] })).toThrow();
});

it("rejects partial paginated catalogs instead of silently limiting all models", async () => {
  const fx = await fixture((_request, response) => response.end(JSON.stringify({ data: [{ id: "first-page" }], has_more: true, last_id: "first-page" })));
  await expect(discoverAccountModels(fx.config, fx.config.accounts[0]!)).rejects.toThrow("paginated");
});

it("preserves unknown model limits through discovery, the account API and workspace catalog", async () => {
  const fx = await fixture((_request, response) => response.end(JSON.stringify({ data: [{ id: "unknown" }, { id: "output-only", max_output_tokens: 128_000 }] })));
  const expected = [{ id: "unknown", name: "unknown", api: "responses" }, { id: "output-only", name: "output-only", api: "responses", output: 128_000 }];
  expect(await discoverAccountModels(fx.config, fx.config.accounts[0]!)).toEqual(expected);
  expect(await invokeRouterOperation(fx.config, fx.router.ledger, "account.models", { accountId: "one" })).toEqual(expected);
  const catalog = await fetch(fx.origin + "/v1/models", { headers: fx.headers });
  expect((await catalog.json()).data).toEqual(expected.map((model) => ({ ...model, object: "model", owned_by: "dim-route" })));
});
it("accepts omitted explicit model limits and strictly validates supplied bounds", () => {
  const model = { id: "model", name: "Model", api: "responses" };
  expect(parseModel(model)).toEqual(model);
  expect(parseModel({ ...model, context: 1_050_000 })).toEqual({ ...model, context: 1_050_000 });
  for (const invalid of [null, 0, -1, 1.5, "128000", Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => parseModel({ ...model, context: invalid })).toThrow();
    expect(() => parseModel({ ...model, output: invalid })).toThrow();
  }
});
