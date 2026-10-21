import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createLlmRouterClient, llmOperation, llmOperations } from "../../../packages/clients/llm-router/src/index.js";
import { operationDescriptors } from "../../../packages/contracts/operations/src/index.js";
import { runLlmRouterCommand } from "../../../packages/cli/plugins/llm-router/src/index.js";
import { RouterLedger } from "../../../packages/control-plane/plugins/llm-router/src/ledger.js";
import { createRouterOperatorServer } from "../../../packages/control-plane/plugins/llm-router/src/operator-server.js";
import { createRouter } from "../../../packages/control-plane/plugins/llm-router/src/server.js";
import { backendProfile, defaultLimits, loadConfig, parseConfig } from "../../../packages/control-plane/plugins/llm-router/src/config.js";
import { backupRouter, restoreRouter } from "../../../packages/control-plane/plugins/llm-router/src/operator.js";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of closers.splice(0).reverse()) await close(); });
async function listen(server: Server) { await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("missing listener"); return `http://127.0.0.1:${address.port}`; }
async function fixture(backendHandler?: (request: IncomingMessage, response: ServerResponse) => void) {
  const directory = await mkdtemp(join(tmpdir(), "dim-router-operator-")); closers.push(() => rm(directory, { recursive: true, force: true }));
  const key = () => randomBytes(32).toString("base64url"), admin = key(), reader = key(), issuer = key();
  const privateWrite = async (name: string, text: string) => { const path = join(directory, name); await writeFile(path, text, { mode: 0o600 }); return path; };
  const upstream = createServer(backendHandler ?? ((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); })); const backend = await listen(upstream);
  closers.push(async () => { upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); });
  const adminPath = await privateWrite("admin.key", admin), readerPath = await privateWrite("reader.key", reader), issuerPath = await privateWrite("issuer.key", issuer);
  const config = parseConfig({ schemaVersion: 3, stateDirectory: join(directory, "state"), listen: { host: "127.0.0.1", port: 8318 }, backend: backendProfile, accounts: [{ id: "provider", reference: "subscription-one", endpoint: backend, keyFile: await privateWrite("provider.key", "secret-provider-key") }], routes: [{ id: "default", accountId: "provider", models: [{ id: "test-model", name: "Test model", api: "responses", context: 1000, output: 100 }] }], limits: defaultLimits, hostIssuers: [{ id: "host", keyFile: issuerPath, projects: [{ id: "demo", routeIds: ["default"] }] }], operators: [{ id: "admin", keyFile: adminPath, role: "operator" }, { id: "observer", keyFile: readerPath, role: "read" }] });
  const router = await createRouter(config); closers.push(() => router.close()); const endpoint = await listen(router.server);
  const connection = await privateWrite("connection.json", JSON.stringify({ schemaVersion: 1, endpoint, actorId: "admin", keyFile: adminPath }));
  const observer = await privateWrite("observer.json", JSON.stringify({ schemaVersion: 1, endpoint, actorId: "observer", keyFile: readerPath }));
  return { directory, config, router, endpoint, admin, issuer, adminPath, connection, observer, client: createLlmRouterClient(connection), privateWrite };
}
it("shares checked operation definitions across remote CLI and service without exposing provider or workspace secrets", async () => {
  const fx = await fixture(), out = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(fx.client.operations()).toEqual(operationDescriptors(llmOperations));
  expect(await fx.client.invoke("overview", {})).toMatchObject({ accounts: [{ id: "provider", reference: "subscription-one" }] });
  expect(await fx.client.invoke("health", {})).toMatchObject([{ backendAuthentication: "accepted", billableInferencePerformed: false }]);
  await runLlmRouterCommand(["llm-router", "project.create", "--connection", fx.connection, "--project", "demo", "--route", "default"]);
  expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({ id: "demo", enabled: true, paused: false });
  await fx.client.invoke("project.state", { projectId: "demo", action: "pause" });
  expect(await fx.client.invoke("project.policy", { projectId: "demo" })).toMatchObject({ paused: true });
  expect(await fx.client.invoke("usage", { projectId: "demo" })).toMatchObject({ requests: 0, allowance: { paused: true } });
  const token = fx.router.ledger.issue({ id: "a2222222-2222-4222-8222-222222222222", name: "workspace-one" }, "default", "demo");
  const principals = await fx.client.invoke("principals", {});
  const serialized = JSON.stringify({ overview: await fx.client.invoke("overview", {}), principals, usage: await fx.client.invoke("usage", { projectId: "demo" }) });
  for (const forbidden of [token, fx.admin, "secret-provider-key", fx.adminPath, "token_hash", "credentialDirectory", "keyFile"]) expect(serialized).not.toContain(forbidden);
  await fx.client.invoke("project.state", { projectId: "demo", action: "resume" });
  const grant = fx.router.ledger.authenticate(token); if (!grant) throw new Error("missing issued grant");
  const request = fx.router.ledger.reserve(grant, "test-model", "observed", 0, fx.config.limits, { accountId: "provider" });
  expect(await fx.client.invoke("requests", { active: true })).toMatchObject([{ id: request.id, model: "test-model", occupied: 1 }]);
  expect(await fx.client.invoke("request.cancel", { requestId: request.id })).toEqual({ cancellationRequested: true, upstreamTerminationConfirmed: false });
  expect(fx.router.ledger.cancelled(request.id)).toBe(true);
  await expect(fx.client.invoke("request.resolve", { requestId: request.id })).rejects.toThrow("HTTP 409");
  fx.router.ledger.finish(request.id, { outcome: "uncertain", captureComplete: false });
  expect(await fx.client.invoke("request.resolve", { requestId: request.id, usage: { inputTokens: 7, outputTokens: 2 } })).toEqual({ resolved: true });
  expect(await fx.client.invoke("usage", { projectId: "demo" })).toMatchObject({ knownInputTokens: 7, knownOutputTokens: 2 });
  await fx.client.invoke("principal.revoke", { principalId: "a2222222-2222-4222-8222-222222222222" });
  expect(fx.router.ledger.authenticate(token)).toBeUndefined();
  expect(await fx.client.invoke("requests", { limit: 3 })).toMatchObject([{ id: request.id, input_tokens: 7, output_tokens: 2 }]);
  const project = fx.router.ledger.project("demo");
  expect(await fx.client.invoke("project.policy.update", { projectId: "demo", expectedRevision: project.revision, policy: { ...project.policy, captureMode: "metadata" } })).toMatchObject({ policy: { captureMode: "metadata" } });
  await expect(fx.client.invoke("project.policy.update", { projectId: "demo", expectedRevision: project.revision, policy: project.policy })).rejects.toThrow("HTTP 409");
  expect(fx.router.ledger.database.prepare("SELECT actor FROM audit WHERE operation='remote.project.create'").get()?.actor).toBe("admin");
});
it("enforces service roles and denies inference and issuer credentials on operator endpoints", async () => {
  const fx = await fixture();
  await fx.client.invoke("project.create", { projectId: "demo", routeId: "default" });
  const observer = createLlmRouterClient(fx.observer);
  expect((await observer.capabilities()).every((op) => op.access === "read")).toBe(true);
  expect((await fx.client.capabilities()).some((op) => op.name === "project.create")).toBe(true);
  expect(await observer.invoke("projects", {})).toMatchObject([{ id: "demo" }]);
  await expect(observer.invoke("project.state", { projectId: "demo", action: "disable" })).rejects.toThrow("permission denied");
  expect(fx.router.ledger.project("demo").enabled).toBe(true);
  const workspaceToken = fx.router.ledger.issue({ id: "a2222222-2222-4222-8222-222222222222", name: "workspace-one" }, "default", "demo");
  for (const authorization of [`Bearer ${workspaceToken}`, `Basic ${Buffer.from(`host:${fx.issuer}`).toString("base64")}`, `Basic ${Buffer.from(`admin:${fx.issuer}`).toString("base64")}`]) {
    const response = await fetch(`${fx.endpoint}/v1/operator/operations/projects`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}" }); expect(response.status).toBe(401);
  }
  await writeFile(fx.adminPath, fx.issuer, { mode: 0o600 });
  await expect(fx.client.invoke("projects", {})).rejects.toThrow("authentication failed");
});
it("checks input, output, private files and allowed CLI flags before exposing remote data", async () => {
  const fx = await fixture();
  await expect(fx.client.invoke("project.create", { projectId: "demo", routeId: "default", token: "not-supported" })).rejects.toThrow();
  await expect(runLlmRouterCommand(["llm-router", "overview", "--connection", fx.connection, "--project", "other"])).rejects.toThrow("unsupported option");
  expect(() => llmOperation("requests").parseInput({ limit: 201 })).toThrow();
  expect(() => llmOperation("overview").parseOutput({ token: "never-display" })).toThrow();
  await chmod(fx.connection, 0o644); await expect(fx.client.invoke("projects", {})).rejects.toThrow("mode-0600");
  expect(() => operationDescriptors([llmOperations[0]!, llmOperations[0]!])).toThrow("duplicate");
});

it("preserves separately provisioned operator credentials in private consistent backup and restore", async () => {
  const fx = await fixture();
  await fx.client.invoke("project.create", { projectId: "demo", routeId: "default" });
  await fx.router.close();
  await backupRouter(fx.config, join(fx.directory, "backup"));
  const restored = await loadConfig(await restoreRouter(join(fx.directory, "backup"), join(fx.directory, "restored")));
  expect(restored.operators).toMatchObject([{ id: "admin", role: "operator" }, { id: "observer", role: "read" }]);
  expect(await readFile(restored.operators![0]!.keyFile, "utf8")).toBe(fx.admin);
  expect(restored.operators![0]!.keyFile).not.toBe(fx.adminPath);
  const router = await createRouter(restored); closers.push(() => router.close()); const endpoint = await listen(router.server);
  const connection = await fx.privateWrite("restored-connection.json", JSON.stringify({ schemaVersion: 1, endpoint, actorId: "admin", keyFile: restored.operators![0]!.keyFile }));
  expect(await createLlmRouterClient(connection).invoke("projects", {})).toMatchObject([{ id: "demo" }]);
});

it("serves independent operator traffic beside live inference without recovering or taking over active requests", async () => {
  let pending: ServerResponse | undefined;
  const dispatched = Promise.withResolvers<void>();
  const complete = (response: ServerResponse) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ object: "response", status: "completed", model: "test-model", output: [], usage: { input_tokens: 3, output_tokens: 1 } })); };
  let inferenceCalls = 0;
  const fx = await fixture((request, response) => {
    if (request.url === "/v1/responses" && inferenceCalls++ === 0) { pending = response; dispatched.resolve(); }
    else complete(response);
  });
  await fx.client.invoke("project.create", { projectId: "demo", routeId: "default" });
  const token = fx.router.ledger.issue({ id: "a2222222-2222-4222-8222-222222222222", name: "workspace-one" }, "default", "demo");
  const infer = () => fetch(`${fx.endpoint}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "test-model", input: "hello" }) });
  const inference = infer(); await dispatched.promise;
  const before = fx.router.ledger.database.prepare("SELECT id,outcome,execution FROM requests WHERE outcome='running'").get();
  expect(before).toMatchObject({ outcome: "running", execution: "dispatched" });
  const operator = await createRouterOperatorServer(fx.config); closers.push(() => operator.close()); const endpoint = await listen(operator.server);
  const connection = await fx.privateWrite("independent.json", JSON.stringify({ schemaVersion: 1, endpoint, actorId: "admin", keyFile: fx.adminPath }));
  const client = createLlmRouterClient(connection);
  expect(await client.invoke("requests", { active: true })).toMatchObject([{ id: before!.id, outcome: "running", execution: "dispatched" }]);
  expect(fx.router.ledger.request(String(before!.id))).toMatchObject({ outcome: "running", execution: "dispatched", occupied: 1 });
  expect((await fetch(`${endpoint}/v1/responses`, { method: "POST", body: "{}" })).status).toBe(404);
  complete(pending!); expect((await inference).status).toBe(200);
  expect(await client.invoke("usage", { projectId: "demo" })).toMatchObject({ requests: 1, knownInputTokens: 3 });
  await operator.close();
  expect((await infer()).status).toBe(200);
  const restarted = await createRouterOperatorServer(fx.config); closers.push(() => restarted.close()); await listen(restarted.server);
  await fx.router.close();
  await expect(backupRouter(fx.config, join(fx.directory, "blocked-backup"))).rejects.toThrow("stop the router operator service");
});

it("attaches only to the exact existing schema without rewriting its inference-owned format marker", async () => {
  const fx = await fixture();
  await fx.client.invoke("project.create", { projectId: "demo", routeId: "default" });
  await fx.router.close();
  const file = join(fx.config.stateDirectory, "router.sqlite3");
  const db = new DatabaseSync(file); db.exec("PRAGMA user_version=2"); db.close();
  expect(() => new RouterLedger(fx.config.stateDirectory)).toThrow("unsupported router state");
  const operator = await createRouterOperatorServer(fx.config); closers.push(() => operator.close()); const endpoint = await listen(operator.server);
  const connection = await fx.privateWrite("verified-shared.json", JSON.stringify({ schemaVersion: 1, endpoint, actorId: "admin", keyFile: fx.adminPath }));
  const client = createLlmRouterClient(connection);
  expect(await client.invoke("projects", {})).toMatchObject([{ id: "demo" }]);
  expect(await client.invoke("project.state", { projectId: "demo", action: "pause" })).toMatchObject({ paused: true });
  expect(operator.ledger.database.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
  await operator.close();
  const observer = new DatabaseSync(file); expect(observer.prepare("PRAGMA user_version").get()?.user_version).toBe(2); observer.close();
  expect(() => new RouterLedger(fx.config.stateDirectory)).toThrow("unsupported router state");
});
it("rejects extra triggers, changed columns and missing indexes instead of trusting a database format marker", async () => {
  for (const mutation of ["CREATE TRIGGER external_audit AFTER INSERT ON audit BEGIN SELECT 1; END", "ALTER TABLE projects ADD COLUMN unexpected TEXT", "DROP INDEX active_requests", "CREATE INDEX unexpected_index ON audit(actor)"]) {
    const fx = await fixture(); await fx.router.close();
    const db = new DatabaseSync(join(fx.config.stateDirectory, "router.sqlite3")); db.exec(mutation); db.close();
    await expect(createRouterOperatorServer(fx.config)).rejects.toThrow("schema does not exactly match");
  }
  const fx = await fixture(), missing = join(fx.directory, "missing-ledger"); await mkdir(missing, { mode: 0o700 });
  expect(() => RouterLedger.openShared(missing)).toThrow("requires an existing ledger");
  await expect(readFile(join(missing, "router.sqlite3"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("never accepts historical workspace tokens as operator credentials after revocation or project disable", async () => {
  for (const state of ["revoked", "disabled"] as const) {
    const fx = await fixture(); await fx.client.invoke("project.create", { projectId: "demo", routeId: "default" });
    const token = fx.router.ledger.issue({ id: "a2222222-2222-4222-8222-222222222222", name: "workspace-one" }, "default", "demo");
    if (state === "revoked") fx.router.ledger.revoke("a2222222-2222-4222-8222-222222222222"); else fx.router.ledger.setProject("demo", "disable");
    expect(fx.router.ledger.authenticate(token)).toBeUndefined();
    await writeFile(fx.adminPath, token, { mode: 0o600 });
    await expect(fx.client.invoke("capabilities", {})).rejects.toThrow("authentication failed");
  }
});
it("keeps operator diagnostics available when an unrelated backend key is unavailable", async () => {
  const fx = await fixture(); await rm(fx.config.accounts[0]!.keyFile);
  expect((await fx.client.capabilities()).some((op) => op.name === "health")).toBe(true);
  expect(await fx.client.invoke("projects", {})).toEqual([]);
  const health = await fx.client.invoke("health", {});
  expect(health).toMatchObject([{ accountId: "provider", backendAuthentication: "unknown", billableInferencePerformed: false }]);
  expect(JSON.stringify(health)).not.toContain(fx.config.accounts[0]!.keyFile);
  await rm(fx.adminPath);
  await expect(fx.client.invoke("capabilities", {})).rejects.toThrow();
  const response = await fetch(`${fx.endpoint}/v1/operator/operations/capabilities`, { method: "POST", headers: { authorization: `Basic ${Buffer.from(`admin:${fx.admin}`).toString("base64")}` }, body: "{}" });
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain(fx.adminPath);
});
