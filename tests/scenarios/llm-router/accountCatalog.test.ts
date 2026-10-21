import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRouter } from "../../../packages/control-plane/plugins/llm-router/src/server.js";
import { afterEach, expect, it } from "vitest";
import { backendProfile, defaultLimits, type RouterConfig } from "../../../packages/control-plane/plugins/llm-router/src/config.js";
import { addRouterAccount, effectiveRouterConfig, upsertRouterRoute } from "../../../packages/control-plane/plugins/llm-router/src/account-catalog.js";
import { closeManagedBackends } from "../../../packages/control-plane/plugins/llm-router/src/managed-backend.js";
import { invokeRouterOperation } from "../../../packages/control-plane/plugins/llm-router/src/operations.js";
import { RouterLedger } from "../../../packages/control-plane/plugins/llm-router/src/ledger.js";
import { backupRouter, restoreRouter } from "../../../packages/control-plane/plugins/llm-router/src/operator.js";
import { loadConfig } from "../../../packages/control-plane/plugins/llm-router/src/config.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-account-catalog-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "backend.ts"), source = await readFile(new URL("./managedBackendFixture.ts", import.meta.url), "utf8");
  await writeFile(binary, `#!${process.execPath}\n${source.replace("response.end('{\"data\":[]}');", "response.end(JSON.stringify(request.method === 'POST' ? { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } } : { data: [] }));")}`, { mode: 0o700 });
  const stateDirectory = join(root, "state"); await mkdir(stateDirectory, { mode: 0o700 });
  const keyFile = join(root, "existing.key"); await writeFile(keyFile, "existing-key", { mode: 0o600 });
  const model = { id: "test-model", name: "Test", api: "chat" as const, context: 1000, output: 100 };
  const config: RouterConfig = { schemaVersion: 3, stateDirectory, listen: { host: "127.0.0.1", port: 8318 }, backend: backendProfile,
    accounts: [{ id: "existing", reference: "Existing", endpoint: "http://127.0.0.1:1", keyFile }], routes: [{ id: "default", accountId: "existing", models: [model] }], limits: defaultLimits, hostIssuers: [], accountManagement: { backendExecutable: binary } };
  const ledger = new RouterLedger(stateDirectory); cleanup.push(async () => ledger.close()); cleanup.push(() => closeManagedBackends(config));
  return { root, config, ledger, model };
}
it("persists multiple credential partitions independently from route bindings and never returns secrets", async () => {
  const { config, ledger, model } = await fixture();
  await invokeRouterOperation(config, ledger, "account.create", { accountId: "one", reference: "First API", provider: "openai", endpoint: "https://first.example/v1", apiKey: "first-private-api-key" });
  await invokeRouterOperation(config, ledger, "account.create", { accountId: "two", reference: "Second API", provider: "anthropic", endpoint: "https://second.example", apiKey: "second-private-api-key" });
  expect((await effectiveRouterConfig(config)).routes).toEqual(config.routes);
  await invokeRouterOperation(config, ledger, "route.upsert", { routeId: "route-one", accountId: "one", models: [model] });
  await invokeRouterOperation(config, ledger, "route.upsert", { routeId: "route-two", accountId: "two", models: [model] });
  expect((await effectiveRouterConfig(config)).routes.map(({ accountId }) => accountId)).toEqual(["existing", "one", "two"]);
  expect((await stat(join(config.stateDirectory, "account-catalog.json"))).mode & 0o777).toBe(0o600);
  const publicData = JSON.stringify({ accounts: await invokeRouterOperation(config, ledger, "accounts", {}), overview: await invokeRouterOperation(config, ledger, "overview", {}), audit: ledger.database.prepare("SELECT * FROM audit").all() });
  for (const forbidden of ["first-private-api-key", "second-private-api-key", config.stateDirectory, "keyFile", "credentialDirectory"]) expect(publicData).not.toContain(forbidden);
  await expect(addRouterAccount(config, { accountId: "one", reference: "Duplicate", provider: "codex" })).rejects.toThrow("already exists");
  await expect(upsertRouterRoute(config, { id: "missing", accountId: "unknown", models: [model] })).rejects.toThrow("not found");
  expect((await effectiveRouterConfig(config)).accounts).toHaveLength(3);
});
it("backs up dynamic credentials, routes and worker configuration and rewrites private paths on restore", async () => {
  const { root, config, model, ledger } = await fixture();
  await addRouterAccount(config, { accountId: "api", reference: "API", provider: "openai", endpoint: "https://first.example/v1", apiKey: "preserved-private-key" });
  await upsertRouterRoute(config, { id: "api-route", accountId: "api", models: [model] });
  await backupRouter(config, join(root, "backup"), { backendStateQuiesced: true });
  const restored = await loadConfig(await restoreRouter(join(root, "backup"), join(root, "restore")));
  expect(restored.routes.find(({ id }) => id === "api-route")?.accountId).toBe("api");
  const account = restored.accounts.find(({ id }) => id === "api")!;
  expect(account.keyFile).toContain(join(root, "restore/state/managed-accounts/api"));
  const worker = JSON.parse(await readFile(join(root, "restore/state/managed-accounts/api/config.yaml"), "utf8"));
  expect(worker.oauth["auth-dir"]).toBe(account.credentialDirectory);
  expect(JSON.stringify(worker)).toContain("preserved-private-key");
  expect(JSON.stringify(worker)).not.toContain(config.stateDirectory);
  expect(ledger.database.prepare("SELECT count(*) AS total FROM audit").get()?.total).toBeGreaterThan(0);
});

it("routes live admissions through separate account workers and records account-specific usage", async () => {
  const { config, model } = await fixture();
  await addRouterAccount(config, { accountId: "one", reference: "One", provider: "openai", endpoint: "https://first.example/v1", apiKey: "first-key" });
  await addRouterAccount(config, { accountId: "two", reference: "Two", provider: "openai", endpoint: "https://first.example/v1", apiKey: "second-key" });
  for (const accountId of ["one", "two"]) await upsertRouterRoute(config, { id: accountId, accountId, models: [model] });
  const router = await createRouter(config); cleanup.push(() => router.close());
  await new Promise<void>((resolve) => router.server.listen(0, "127.0.0.1", resolve));
  const address = router.server.address(); if (!address || typeof address === "string") throw new Error("missing address");
  router.ledger.createProject("demo", { allowedRoutes: ["one", "two"], limits: defaultLimits, captureMode: "metadata", tokenMode: "observe" });
  for (const routeId of ["one", "two"]) {
    const token = router.ledger.issue({ id: routeId, name: routeId }, routeId, "demo");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: model.id, messages: [] }) });
    expect(response.status).toBe(200); await response.json();
  }
  expect(router.ledger.database.prepare("SELECT account_id,outcome,input_tokens,output_tokens FROM requests ORDER BY rowid").all()).toEqual([
    { account_id: "one", outcome: "completed", input_tokens: 1, output_tokens: 2 },
    { account_id: "two", outcome: "completed", input_tokens: 1, output_tokens: 2 }
  ]);
});
