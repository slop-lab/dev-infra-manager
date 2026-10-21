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
  await invokeRouterOperation(config, router.ledger, "account.rename", { accountId: "one", reference: "Renamed after usage" });
  expect((await effectiveRouterConfig(config)).routes.find(({ id }) => id === "one")?.accountId).toBe("one");
  expect(router.ledger.database.prepare("SELECT account_id,outcome,input_tokens,output_tokens FROM requests ORDER BY rowid").all()).toEqual([
    { account_id: "one", outcome: "completed", input_tokens: 1, output_tokens: 2 },
    { account_id: "two", outcome: "completed", input_tokens: 1, output_tokens: 2 }
  ]);
});

it("enrolls accounts without manual metadata, derives a safe Codex email and keeps identity stable when renamed", async () => {
  const { config, ledger, model } = await fixture();
  const first = await invokeRouterOperation(config, ledger, "account.create", { provider: "codex" }) as { id: string; reference: string };
  const second = await invokeRouterOperation(config, ledger, "account.create", { provider: "codex" }) as { id: string; reference: string };
  expect(first).toMatchObject({ reference: "Codex", provider: "codex", status: "authorization_required" });
  expect(first.id).toMatch(/^codex-[a-f0-9-]{36}$/);
  expect(second.id).not.toBe(first.id);
  const effective = await effectiveRouterConfig(config), account = effective.accounts.find(({ id }) => id === first.id)!;
  const credential = { type: "codex", email: "person@example.com", refresh_token: "private-refresh-token", access_token: "private-access-token", account_id: "private-provider-identity" };
  await writeFile(join(account.credentialDirectory!, "credential.json"), JSON.stringify(credential), { mode: 0o600 });
  const summaries = await invokeRouterOperation(config, ledger, "accounts", {}) as { id: string; reference: string }[];
  expect(summaries.find(({ id }) => id === first.id)).toMatchObject({ reference: "person@example.com", status: "connected" });
  for (const value of ["private-refresh-token", "private-access-token", "private-provider-identity", account.credentialDirectory!, account.keyFile]) expect(JSON.stringify(summaries)).not.toContain(value);
  await invokeRouterOperation(config, ledger, "route.upsert", { routeId: "codex", accountId: first.id, models: [model] });
  const renamed = await invokeRouterOperation(config, ledger, "account.rename", { accountId: first.id, reference: " Work account " });
  expect(renamed).toMatchObject({ id: first.id, reference: "Work account", status: "connected" });
  const after = await effectiveRouterConfig(config);
  expect(after.accounts.find(({ id }) => id === first.id)).toEqual({ ...account, reference: "Work account" });
  expect(after.routes.find(({ id }) => id === "codex")?.accountId).toBe(first.id);
  expect(JSON.parse(await readFile(join(account.credentialDirectory!, "credential.json"), "utf8"))).toEqual(credential);
  await expect(invokeRouterOperation(config, ledger, "account.rename", { accountId: "existing", reference: "External" })).rejects.toThrow("configuration accounts");
  await expect(invokeRouterOperation(config, ledger, "account.rename", { accountId: first.id, reference: "  " })).rejects.toThrow();
  await expect(invokeRouterOperation(config, ledger, "account.create", { provider: "codex", accountId: "../escape" })).rejects.toThrow();
});
it("uses provider labels for API connections and ignores unsafe credential display metadata", async () => {
  const { config, ledger } = await fixture();
  const api = await invokeRouterOperation(config, ledger, "account.create", { provider: "openai", endpoint: "https://first.example/v1", apiKey: "private-key" }) as { id: string; reference: string };
  expect(api).toMatchObject({ reference: "OpenAI compatible API", status: "connected" });
  const codex = await addRouterAccount(config, { provider: "codex" });
  await writeFile(join(codex.credentialDirectory!, "credential.json"), JSON.stringify({ type: "codex", email: "<script>@example.com", refresh_token: "private-token" }), { mode: 0o600 });
  const summaries = await invokeRouterOperation(config, ledger, "accounts", {}) as { id: string; reference: string }[];
  expect(summaries.find(({ id }) => id === codex.id)).toMatchObject({ reference: "Codex", status: "connected" });
  expect(JSON.stringify(summaries)).not.toContain("private-key");
});
