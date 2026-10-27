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
const supportedModels = ["first", "second", "stable", "cooling", "allowed", "denied"].map((id) => ({ id, name: id, api: "responses" as const }));
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(handle: (request: IncomingMessage, response: ServerResponse) => void, inventory = supportedModels) {
  const root = await mkdtemp(join(tmpdir(), "dim-model-catalog-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const upstream = createServer(handle); await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); });
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("missing address");
  const endpoint = `http://127.0.0.1:${address.port}`, keyFile = join(root, "key"); await writeFile(keyFile, "private-key", { mode: 0o600 });
  const config = parseConfig({ schemaVersion: 3, stateDirectory: join(root, "state"), hostIssuers: [], listen: { host: "127.0.0.1", port: 8318 }, backend: backendProfile,
    accounts: [{ id: "one", reference: "One account", endpoint, keyFile, supportedModels: inventory }], routes: [{ id: "default", accountId: "one", models: "all" }], limits: defaultLimits });
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
  expect(await discoverAccountModels(fx.config, fx.config.accounts[0]!)).toMatchObject([{ id: "first", api: "responses", context: 200_000, output: 20_000 }]);
  ids = ["first", "second"];
  expect(await discoverAccountModels(fx.config, fx.config.accounts[0]!)).toHaveLength(1); expect(discoveries).toBe(1);
  clock.mockReturnValue(now + 30_001);
  expect(await discoverAccountModels(fx.config, fx.config.accounts[0]!)).toHaveLength(2); expect(discoveries).toBe(2);
  expect(await invokeRouterOperation(fx.config, fx.router.ledger, "overview", {})).toMatchObject({ routes: [{ models: "all" }] });
  expect(await invokeRouterOperation(fx.config, fx.router.ledger, "account.models", { accountId: "one" })).toHaveLength(2);
  expect((await fetch(fx.origin + "/v1/responses", { method: "POST", headers: fx.headers, body: JSON.stringify({ model: "not-in-account", input: [] }) })).status).toBe(403);
  expect(discoveries).toBe(3);
  failed = true; clock.mockReturnValue(now + 60_002);
  await expect(discoverAccountModels(fx.config, fx.config.accounts[0]!)).rejects.toThrow(/discovery is unavailable/);
});
it("keeps a previously authorized all-route model retryable through transient catalog disappearance", async () => {
  let ids = ["stable", "cooling"], recovered = false, inferenceCalls = 0;
  const fx = await fixture((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
      return;
    }
    inferenceCalls++;
    response.writeHead(recovered ? 200 : 500, { "content-type": "application/json" });
    response.end(recovered
      ? JSON.stringify({ id: "response", object: "response", status: "completed", error: null, incomplete_details: null,
        model: "cooling", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
      : JSON.stringify({ error: { code: "server_error", message: "model cooling down" } }));
  });
  const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
  expect(await discoverAccountModels(fx.config, fx.config.accounts[0]!)).toHaveLength(2);
  ids = ["stable"];
  clock.mockReturnValue(now + 20 * 60_000 + 1);
  expect(await discoverAccountModels(fx.config, fx.config.accounts[0]!)).toMatchObject([{ id: "stable" }]);
  const published = await fetch(fx.origin + "/v1/models", { headers: fx.headers });
  expect((await published.json())).toMatchObject({ data: expect.arrayContaining([
    expect.objectContaining({ id: "stable" }), expect.objectContaining({ id: "cooling" })
  ]) });

  const unavailable = await fetch(fx.origin + "/v1/responses", { method: "POST", headers: fx.headers,
    body: JSON.stringify({ model: "cooling", input: [] }) });
  expect(unavailable.status).toBe(500);
  expect(unavailable.headers.get("x-dim-error-category")).toBe("upstream_rejected");
  expect(inferenceCalls).toBe(1);

  await fx.router.close();
  const restarted = await createRouter(fx.config); cleanup.push(() => restarted.close());
  await new Promise<void>((resolve) => restarted.server.listen(0, "127.0.0.1", resolve));
  const address = restarted.server.address(); if (!address || typeof address === "string") throw new Error("missing restarted router address");
  recovered = true;
  const capabilities = await fetch(`http://127.0.0.1:${address.port}/v1/capabilities`, { headers: fx.headers });
  expect((await capabilities.json())).toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ id: "cooling" })]) });
  expect((await fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: "POST", headers: fx.headers,
    body: JSON.stringify({ model: "cooling", input: [] }) })).status).toBe(200);
  expect(inferenceCalls).toBe(2);
});
it("applies explicit route denial and principal revocation immediately despite prior all-route discovery", async () => {
  let inferenceCalls = 0;
  const fx = await fixture((request, response) => {
    if (request.url === "/v1/models") response.end(JSON.stringify({ data: [{ id: "allowed" }, { id: "denied" }] }));
    else { inferenceCalls++; response.end(JSON.stringify({ status: "completed", model: "allowed", output: [], usage: { input_tokens: 1, output_tokens: 1 } })); }
  });
  expect(await discoverAccountModels(fx.config, fx.config.accounts[0]!)).toHaveLength(2);
  fx.config.routes[0] = { ...fx.config.routes[0]!, models: [{ id: "allowed", name: "allowed", api: "responses" }] };

  expect((await fetch(fx.origin + "/v1/responses", { method: "POST", headers: fx.headers,
    body: JSON.stringify({ model: "denied", input: [] }) })).status).toBe(403);
  expect(inferenceCalls).toBe(0);
  fx.router.ledger.revoke("workspace");
  expect((await fetch(fx.origin + "/v1/responses", { method: "POST", headers: fx.headers,
    body: JSON.stringify({ model: "allowed", input: [] }) })).status).toBe(401);
  expect(inferenceCalls).toBe(0);
});
it("returns an actionable service error when an all-model route loses its authoritative inventory", async () => {
  const fx = await fixture((_request, response) => response.end(JSON.stringify({ data: [{ id: "stable" }] })));
  delete fx.config.accounts[0]!.supportedModels;
  const response = await fetch(fx.origin + "/v1/responses", { method: "POST", headers: fx.headers,
    body: JSON.stringify({ model: "stable", input: [] }) });
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("registered supportedModels inventory");
});
it.each(["account", "principal", "project"] as const)("denies inference without backend dispatch after %s revocation", async (revocation) => {
  let ids = ["allowed"], inferenceCalls = 0;
  const fx = await fixture((request, response) => {
    if (request.url === "/v1/models") response.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
    else { inferenceCalls++; response.end(JSON.stringify({ status: "completed", model: "allowed", output: [], usage: { input_tokens: 1, output_tokens: 1 } })); }
  });
  const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
  expect(await discoverAccountModels(fx.config, fx.config.accounts[0]!)).toHaveLength(1);
  ids = ["other"]; clock.mockReturnValue(now + 30_001);
  expect(await discoverAccountModels(fx.config, fx.config.accounts[0]!)).toHaveLength(1);
  if (revocation === "account") fx.config.accounts.splice(0);
  else if (revocation === "principal") fx.router.ledger.revoke("workspace");
  else fx.router.ledger.setProject("demo", "disable");

  expect((await fetch(fx.origin + "/v1/responses", { method: "POST", headers: fx.headers,
    body: JSON.stringify({ model: "allowed", input: [] }) })).status).toBe(revocation === "account" ? 403 : 401);
  expect(inferenceCalls).toBe(0);
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
it("keeps operator model inspection read-only and separate from inference preparation", async () => {
  // Given: a managed API account has no aliases and inference preparation is already waiting on provider I/O.
  const requests: ServerResponse[] = [];
  const fx = await fixture((_request, response) => { requests.push(response); });
  const path = join(fx.config.stateDirectory, "managed-accounts/api"); await mkdir(path, { recursive: true });
  const file = join(path, "config.yaml");
  await writeFile(file, JSON.stringify({ "api-keys": { "openai-compatibility": [{ "base-url": fx.endpoint + "/v1", keys: [{ "api-key": "provider-secret" }], models: [] }] } }), { mode: 0o600 });
  const account = { ...fx.config.accounts[0]!, id: "api", provider: "openai" as const };
  const config = { ...fx.config, accounts: [account] };
  const preparation = discoverAccountModels(config, account);
  while (requests.length < 1) await new Promise<void>((resolve) => setTimeout(resolve, 10));

  // When: account.models inspects the same account while preparation is pending.
  const inspection = invokeRouterOperation(config, fx.router.ledger, "account.models", { accountId: "api" });
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  let requestCountError: unknown;
  try { expect(requests).toHaveLength(2); }
  catch (error) { requestCountError = error; }
  if (requestCountError !== undefined) {
    requests[0]?.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"prepared-model"}]}');
    await Promise.allSettled([inspection, preparation]);
    throw requestCountError;
  }
  requests[1]?.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"inspection-model"}]}');
  expect(await inspection).toMatchObject([{ id: "inspection-model" }]);
  const inspected = JSON.parse(await readFile(file, "utf8"));
  expect(inspected["api-keys"]["openai-compatibility"][0].models).toEqual([]);

  // Then: inference preparation remains independently pending and retains alias publication ownership.
  requests[0]?.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"prepared-model"}]}');
  expect(await preparation).toMatchObject([{ id: "prepared-model" }]);
  const prepared = JSON.parse(await readFile(file, "utf8"));
  expect(prepared["api-keys"]["openai-compatibility"][0].models).toEqual([{ name: "prepared-model", alias: "prepared-model" }]);
});
it("does not start a managed Codex worker during operator model inspection", async () => {
  // Given: a stopped managed Codex account could be started by the configured backend executable.
  const fx = await fixture((_request, response) => response.end('{"data":[]}'));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("missing reserved address");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const accountPath = join(fx.config.stateDirectory, "managed-accounts/codex");
  await mkdir(join(accountPath, "auth"), { recursive: true, mode: 0o700 });
  await writeFile(join(accountPath, "config.yaml"), JSON.stringify({ server: { host: "127.0.0.1", port: address.port }, oauth: { "auth-dir": join(accountPath, "auth") }, access: { "api-keys": ["private-key"] } }), { mode: 0o600 });
  const marker = join(fx.config.stateDirectory, "worker-started");
  const executable = join(fx.config.stateDirectory, "backend.mjs");
  await writeFile(executable, `#!${process.execPath}\nimport { createServer } from "node:http"; import { readFile, writeFile } from "node:fs/promises"; if (process.argv.includes("-h")) console.log("CLIProxyAPI Version: 8.0.33, Commit: fixture"); else { const config = JSON.parse(await readFile(process.argv[process.argv.indexOf("-config") + 1], "utf8")); await writeFile(${JSON.stringify(marker)}, "started"); const server = createServer((_request, response) => response.end('{"data":[{"id":"codex-model"}]}')); server.listen(config.server.port, config.server.host); process.once("SIGTERM", () => server.close()); }\n`, { mode: 0o700 });
  const account = { ...fx.config.accounts[0]!, id: "codex", provider: "codex" as const, endpoint: `http://127.0.0.1:${address.port}`, credentialDirectory: join(accountPath, "auth") };
  const config = { ...fx.config, accounts: [account], accountManagement: { backendExecutable: executable } };

  // When: an operator requests the account catalog while its worker is stopped.
  await expect(invokeRouterOperation(config, fx.router.ledger, "account.models", { accountId: "codex" })).rejects.toThrow();

  // Then: inspection reports unavailability without starting the worker process.
  await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects duplicate catalog entries and unsupported wildcard policy", async () => {
  const fx = await fixture((_request, response) => response.end(JSON.stringify({ data: [{ id: "duplicate" }, { id: "duplicate" }] })));
  await expect(discoverAccountModels(fx.config, fx.config.accounts[0]!)).rejects.toThrow("duplicate");
  expect(() => parseConfig({ ...fx.config, routes: [{ ...fx.config.routes[0], models: "*" }] })).toThrow();
  const account = { ...fx.config.accounts[0] }; delete account.supportedModels;
  expect(parseConfig({ ...fx.config, accounts: [account] }).accounts[0]?.supportedModels).toBeUndefined();
});

it("rejects partial paginated catalogs instead of silently limiting all models", async () => {
  const fx = await fixture((_request, response) => response.end(JSON.stringify({ data: [{ id: "first-page" }], has_more: true, last_id: "first-page" })));
  await expect(discoverAccountModels(fx.config, fx.config.accounts[0]!)).rejects.toThrow("paginated");
});

it("preserves unknown model limits through discovery, the account API and workspace catalog", async () => {
  const expected = [{ id: "unknown", name: "unknown", api: "responses" as const }, { id: "output-only", name: "output-only", api: "responses" as const, output: 128_000 }];
  const fx = await fixture((_request, response) => response.end(JSON.stringify({ data: [{ id: "unknown" }, { id: "output-only", max_output_tokens: 128_000 }] })), expected);
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
