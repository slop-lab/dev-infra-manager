import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceStore } from "@slop-lab/dim-core/workspace";
import { createRouter } from "../../../../plugin-llm-router/src/server.js";
import { parseConfig, parsePolicy, defaultLimits, backendProfile, type RouterConfig } from "../../../../plugin-llm-router/src/config.js";
import { RouterLedger } from "../../../../plugin-llm-router/src/ledger.js";
import { backupRouter, restoreRouter, accountHealth, effectivePolicy } from "../../../../plugin-llm-router/src/operator.js";
import { captureBody, captureManifest, exportCapture, removeCapture } from "../../../../plugin-llm-router/src/archive.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";

type Backend = (request: IncomingMessage, response: ServerResponse) => void;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no listener");
  return `http://127.0.0.1:${address.port}`;
}
async function fixture(backend: Backend, overrides: Partial<RouterConfig["limits"]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "dim-llm-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const upstream = createServer(backend); const endpoint = await listen(upstream);
  cleanup.push(async () => { upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); });
  const store = new WorkspaceStore(join(root, "workspaces")); const workspace = workspaceRecord(); await store.write(workspace);
  const keyFile = join(root, "upstream.key"), upstreamKey = "private-provider-access-key";
  await writeFile(keyFile, upstreamKey, { mode: 0o600 });
  const config = parseConfig({ schemaVersion: 2, backend: backendProfile, accounts: [{id:"default", reference:"operator-exclusive-account", endpoint, keyFile}], stateDirectory: join(root, "router"), workspaceStateRoot: store.root,
    listen: { host: "127.0.0.1", port: 8318 }, routes: [{ id: "default", accountId: "default", models: [
      { id: "reviewed-model", name: "Reviewed model", api: "responses", context: 10000, output: 1000 }] }], limits: { ...defaultLimits, ...overrides } });
  const router = await createRouter(config); const origin = await listen(router.server);
  cleanup.push(() => router.close());
  router.ledger.createProject(workspace.id, {allowedRoutes:["default"],limits:config.limits,captureMode:"required",tokenMode:"observe"});
  const token = router.ledger.issue(workspace, "default", workspace.id);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const request = (extra: object = {}, selectedHeaders: Record<string, string> = headers) => fetch(`${origin}/v1/responses`, { method: "POST", headers: selectedHeaders,
    body: JSON.stringify({ model: "reviewed-model", input: [{ role: "user", content: "hello" }], ...extra }) });
  return { root, router, config, store, workspace, origin, request, headers, upstreamKey, token };
}
function completed(response: ServerResponse) { response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ object: "response", status: "completed", model: "reviewed-model", output: [], usage: { input_tokens: 7, output_tokens: 3 } })); }
async function waitFor(test: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 100; n++) { if (await test()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("condition timed out");
}
it("replaces caller credentials, captures exact bodies and attributes observed usage only to the authenticated workspace", async () => {
  const seen: { authorization?: string; injected?: string } = {};
  const fx = await fixture((request, response) => { const authorization = request.headers.authorization; if (authorization !== undefined) seen.authorization = authorization;
    const injected = request.headers["x-upstream-account"]; if (typeof injected === "string") seen.injected = injected; completed(response); });
  const response = await fx.request({}, { ...fx.headers, "x-upstream-account": "foreign-account" });
  expect(response.status).toBe(200); const bytes = Buffer.from(await response.arrayBuffer());
  expect(seen).toEqual({ authorization: `Bearer ${fx.upstreamKey}` });
  const id = response.headers.get("x-dim-request-id")!;
  expect(await readFile(join(fx.config.stateDirectory, "captures", id, "response.body"))).toEqual(bytes);
  expect(await readFile(join(fx.config.stateDirectory, "captures", id, "request.json"), "utf8")).not.toContain(fx.upstreamKey);
  const usage = await fetch(`${fx.origin}/v1/usage`, { headers: fx.headers });
  expect(await usage.json()).toMatchObject({ projectId: fx.workspace.id, requests: 1, knownInputTokens: 7, knownOutputTokens: 3, unknownUsageRequests: 0 });
  expect(bytes.toString()).not.toContain(fx.upstreamKey);
  const foreign = workspaceRecord("other-workspace"); await fx.store.write(foreign);
  fx.router.ledger.createProject(foreign.id, {allowedRoutes:["default"],limits:defaultLimits,captureMode:"required",tokenMode:"observe"});
  const token = fx.router.ledger.issue(foreign, "default", foreign.id);
  expect(await (await fetch(`${fx.origin}/v1/usage`, { headers: { authorization: `Bearer ${token}` } })).json()).toMatchObject({ requests: 0 });
});
it("forwards streaming tool data byte-for-byte and observes the terminal usage event", async () => {
  const stream = 'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"tool","arguments":"{}"}}\n\n'
    + 'data: {"type":"response.completed","response":{"model":"reviewed-model","usage":{"input_tokens":11,"output_tokens":5}}}\n\n';
  const fx = await fixture((_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(stream.slice(0, 31)); setTimeout(() => response.end(stream.slice(31)), 10); });
  const response = await fx.request({ stream: true }); expect(await response.text()).toBe(stream);
  expect(fx.router.ledger.usage(fx.workspace.id)).toMatchObject({ knownInputTokens: 11, knownOutputTokens: 5 });
});
it("enforces concurrent and daily request allowances atomically and never retries a dispatched request", async () => {
  let calls = 0; let pending: ServerResponse | undefined;
  const fx = await fixture((_request, response) => { calls++; pending = response; }, { concurrent: 1, requestsPerUtcDay: 1 });
  const first = fx.request(); await waitFor(() => calls === 1);
  expect((await fx.request()).status).toBe(429);
  completed(pending!); expect((await first).status).toBe(200);
  expect((await fx.request()).status).toBe(429); expect(calls).toBe(1);
  const secondHandle = new RouterLedger(fx.config.stateDirectory);
  try { expect(secondHandle.usage(fx.workspace.id)).toMatchObject({ requests: 1 }); } finally { secondHandle.close(); }
});
it("rejects cross-workspace selectors, unreviewed models and stateful provider access before dispatch", async () => {
  let calls = 0; const fx = await fixture((_request, response) => { calls++; completed(response); });
  expect((await fx.request({ model: "foreign-model" })).status).toBe(403);
  expect((await fx.request({ previous_response_id: "foreign-response" })).status).toBe(400);
  expect((await fx.request({ account_id: "foreign" })).status).toBe(400);
  expect((await fetch(`${fx.origin}/v1/responses/foreign`, { headers: fx.headers })).status).toBe(404);
  expect(calls).toBe(0);
  await fx.store.write({ ...fx.workspace, id: "a".repeat(8) + "-bbbb-cccc-dddd-" + "e".repeat(12) });
  expect((await fx.request()).status).toBe(401);
});
it("cancels upstream on client disconnect and retains an incomplete durable capture with unknown usage", async () => {
  let closed = false;
  const fx = await fixture((_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'); response.once("close", () => { closed = true; }); });
  const controller = new AbortController();
  const response = await fetch(`${fx.origin}/v1/responses`, { method: "POST", signal: controller.signal, headers: fx.headers,
    body: JSON.stringify({ model: "reviewed-model", input: [], stream: true }) });
  await response.body!.getReader().read(); controller.abort();
  await waitFor(() => closed);
  await waitFor(() => Number(fx.router.ledger.database.prepare("SELECT COUNT(*) AS n FROM requests WHERE outcome='cancelled'").get()?.n) === 1);
  expect(fx.router.ledger.usage(fx.workspace.id)).toMatchObject({ unknownUsageRequests: 1, knownInputTokens: null });
  const row = fx.router.ledger.database.prepare("SELECT * FROM requests").get()!;
  expect(row.capture_complete).toBe(0);
  expect((await readdir(join(fx.config.stateDirectory, "captures"))).length).toBe(1);
});
it("keeps usage across grant rotation and revokes discarded workspace access", async () => {
  const fx = await fixture((_request, response) => completed(response));
  await (await fx.request()).text();
  fx.router.ledger.issue(fx.workspace, "default", fx.workspace.id); expect((await fx.request()).status).toBe(401);
  expect(fx.router.ledger.usage(fx.workspace.id)).toMatchObject({ requests: 1 });
  const token = fx.router.ledger.issue(fx.workspace, "default", fx.workspace.id);
  await fx.store.write({ ...fx.workspace, phase: "discarding" });
  expect((await fx.request({}, { ...fx.headers, authorization: `Bearer ${token}` })).status).toBe(401);
});
it("treats interrupted dispatch as uncertain on restart and does not let administrative readers recover a live request", async () => {
  const fx = await fixture((_request, response) => completed(response));
  const grant = fx.router.ledger.authenticate(fx.token)!;
  const {id} = fx.router.ledger.reserve(grant, "reviewed-model", "policy", 10, defaultLimits, {accountId:"default"});
  fx.router.ledger.dispatch(id);
  const admin = new RouterLedger(fx.config.stateDirectory);
  try { expect(admin.database.prepare("SELECT outcome FROM requests WHERE id=?").get(id)?.outcome).toBe("running"); }
  finally { admin.close(); }
  fx.router.ledger.recoverInterrupted();
  expect(fx.router.ledger.database.prepare("SELECT outcome FROM requests WHERE id=?").get(id)?.outcome).toBe("uncertain");
  expect(fx.router.ledger.usage(fx.workspace.id)).toMatchObject({ unknownUsageRequests: 1 });
});
it("rejects a response larger than the archive allowance without recording a complete exchange", async () => {
  const fx = await fixture((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end("x".repeat(1024)); }, { responseBytes: 32 });
  await expect(fx.request().then((response) => response.text())).rejects.toThrow();
  const row = fx.router.ledger.database.prepare("SELECT outcome,capture_complete FROM requests").get()!;
  expect(row).toMatchObject({ outcome: "failed", capture_complete: 0 });
});

it("shares a stable project allowance across principals and credential rotation without accepting claimed ownership", async () => {
  const fx = await fixture((_request, response) => completed(response), { requestsPerUtcDay: 2 });
  const second = workspaceRecord("second-instance"); await fx.store.write(second);
  const token2 = fx.router.ledger.issue(second, "default", fx.workspace.id, "second-principal");
  await (await fx.request()).text();
  const rotated = fx.router.ledger.issue(fx.workspace, "default", fx.workspace.id);
  expect((await fx.request()).status).toBe(401);
  const response = await fx.request({}, { ...fx.headers, authorization: `Bearer ${token2}` }); expect(response.status).toBe(200); await response.text();
  expect((await fx.request({}, { ...fx.headers, authorization: `Bearer ${rotated}` })).status).toBe(429);
  expect(fx.router.ledger.usage(fx.workspace.id)).toMatchObject({ requests: 2, knownInputTokens: 14 });
  expect((await fetch(`${fx.origin}/v1/usage`, { headers: { ...fx.headers, authorization: `Bearer ${token2}`, "x-dim-project-id": "foreign" } })).status).toBe(403);
  expect((await fx.request({ project_id: "foreign" }, { ...fx.headers, authorization: `Bearer ${rotated}` })).status).toBe(400);
});

it("reserves estimated tokens atomically, exposes unknown reservations, and explicitly rejects unsupported strict profiles", async () => {
  let calls = 0; let pending: ServerResponse | undefined;
  const fx = await fixture((_request, response) => { calls++; pending = response; });
  const policy = parsePolicy({ allowedRoutes: ["default"], limits: defaultLimits, captureMode: "required", tokenMode: "estimate", tokensPerUtcDay: 100, estimatedTokensPerRequest: 60 });
  fx.router.ledger.updatePolicy(fx.workspace.id, policy);
  const first = fx.request(); await waitFor(() => calls === 1);
  expect((await fx.request()).status).toBe(429);
  completed(pending!); await (await first).text();
  expect(fx.router.ledger.usage(fx.workspace.id)).toMatchObject({ tokenReservations: 0, knownInputTokens: 7 });
  expect(() => parsePolicy({ ...policy, tokenMode: "strict" })).toThrow(/no verified consumption/);
  expect(() => parseConfig({ ...fx.config, backend: { ...backendProfile, attemptVisibility: "exact" } })).toThrow(/unsupported backend capabilities/);
  expect(effectivePolicy(fx.config, fx.router.ledger, fx.workspace.id)).toMatchObject({ tokenEnforcement: expect.stringContaining("overage possible") });
});

it("keeps uncertain physical occupancy and estimated reservations until an auditable operator resolution", async () => {
  const fx = await fixture((_request, response) => completed(response), { concurrent: 1 });
  fx.router.ledger.updatePolicy(fx.workspace.id, parsePolicy({ allowedRoutes: ["default"], limits: fx.config.limits, captureMode: "required", tokenMode: "estimate", tokensPerUtcDay: 100, estimatedTokensPerRequest: 60 }));
  const grant = fx.router.ledger.authenticate(fx.token)!;
  const { id } = fx.router.ledger.reserve(grant, "reviewed-model", "revision", 10, fx.config.limits, { accountId: "default" });
  fx.router.ledger.dispatch(id); fx.router.ledger.recoverInterrupted();
  expect(fx.router.ledger.request(id)).toMatchObject({ outcome: "uncertain", execution: "outcome_unknown", occupied: 1, token_reservation: 60 });
  expect((await fx.request()).status).toBe(429);
  fx.router.ledger.resolve(id);
  expect(fx.router.ledger.request(id)).toMatchObject({ occupied: 0, token_reservation: 60, input_tokens: null, accounting: "reconciliation_required" });
  expect((await fx.request()).status).toBe(429); // Unknown consumption was not silently refunded.
  fx.router.ledger.resolve(id, { inputTokens: 10, outputTokens: 10, raw: { operatorObservation: "fixture" }, source: "operator-resolution" });
  await (await fx.request()).text();
  expect(fx.router.ledger.database.prepare("SELECT COUNT(*) AS n FROM audit WHERE operation='request.resolve'").get()?.n).toBe(2);
});

it("captures token-like text, tool/multimodal/unknown fields exactly and serves inert project-filtered originals", async () => {
  let observed = Buffer.alloc(0);
  const fx = await fixture((request, response) => { const chunks: Buffer[] = []; request.on("data", (chunk: Buffer) => chunks.push(chunk)); request.on("end", () => { observed = Buffer.concat(chunks); completed(response); }); });
  const original = Buffer.from(' { "model":"reviewed-model", "input":[{"role":"user","content":[{"type":"input_text","text":"<script>danger()</script> sk-inert-token repeated repeated"},{"type":"input_image","image_url":"https://not-fetched.invalid/image"}]}], "unknown_supported_field":{"tool_call_id":"preserved"} }\n');
  const response = await fetch(`${fx.origin}/v1/responses`, { method: "POST", headers: fx.headers, body: original }); await response.text();
  expect(observed).toEqual(original);
  const id = response.headers.get("x-dim-request-id")!;
  const download = await fetch(`${fx.origin}/v1/requests/${id}/request`, { headers: fx.headers });
  expect(download.headers.get("content-type")).toBe("application/octet-stream"); expect(download.headers.get("content-disposition")).toContain("attachment"); expect(Buffer.from(await download.arrayBuffer())).toEqual(original);
  expect(captureManifest(fx.router.ledger, id)).toMatchObject({ capture: { boundary: "client application protocol bodies", upstreamTranslatedPayloads: "not observed", remoteReferences: "referenced bytes not fetched", complete: true } });
  const foreign = workspaceRecord("foreign"); await fx.store.write(foreign); fx.router.ledger.createProject("foreign-app", { allowedRoutes: ["default"], limits: defaultLimits, captureMode: "required", tokenMode: "observe" });
  const token = fx.router.ledger.issue(foreign, "default", "foreign-app");
  expect((await fetch(`${fx.origin}/v1/requests/${id}/capture`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
  const destination = join(fx.root, "export"); await exportCapture(fx.router.ledger, id, destination);
  expect(await readFile(join(destination, "request.body"))).toEqual(original);
  await removeCapture(fx.router.ledger, id, "expired"); expect(captureManifest(fx.router.ledger, id)).toMatchObject({ capture: { state: "expired", complete: false } });
  expect((await fetch(`${fx.origin}/v1/requests/${id}/request`, { headers: fx.headers })).status).toBe(410);
  expect(fx.router.ledger.usage(fx.workspace.id)).toMatchObject({ requests: 1, captureBytes: 0 });
});

it.each(["required", "best-effort", "metadata"] as const)("makes %s recording failure semantics explicit before dispatch", async (mode) => {
  let calls = 0;
  const fx = await fixture((_request, response) => { calls++; completed(response); });
  fx.router.ledger.updatePolicy(fx.workspace.id, { allowedRoutes: ["default"], limits: defaultLimits, captureMode: mode, tokenMode: "observe" });
  await writeFile(join(fx.config.stateDirectory, "captures"), "archive-unavailable", { mode: 0o600 });
  const response = await fx.request(); await response.text();
  expect(response.status).toBe(mode === "required" ? 503 : 200); expect(calls).toBe(mode === "required" ? 0 : 1);
  const row = fx.router.ledger.database.prepare("SELECT capture_state,capture_complete,execution FROM requests").get();
  expect(row?.capture_state).toBe(mode === "metadata" ? "disabled_by_policy" : "failed"); expect(row?.capture_complete).toBe(0);
  if (mode === "required") expect(row?.execution).toBe("not_dispatched");
});

it("applies new policy to admissions while preserving an active snapshot and separates cancellation from confirmed termination", async () => {
  let pending: ServerResponse | undefined; let calls = 0;
  const fx = await fixture((_request, response) => { pending = response; calls++; });
  const first = fx.request(); await waitFor(() => calls === 1);
  const row = fx.router.ledger.database.prepare("SELECT id,policy_snapshot FROM requests").get()!;
  fx.router.ledger.updatePolicy(fx.workspace.id, { allowedRoutes: ["default"], limits: { ...defaultLimits, responseBytes: 1 }, captureMode: "metadata", tokenMode: "observe" });
  fx.router.ledger.setProject(fx.workspace.id, "pause"); expect((await fx.request()).status).toBe(503);
  completed(pending!); expect((await first).status).toBe(200);
  expect(fx.router.ledger.request(String(row.id))).toMatchObject({ policy_snapshot: row.policy_snapshot, outcome: "completed", capture_state: "complete" });
  fx.router.ledger.setProject(fx.workspace.id, "resume");
  const second = fx.request(); await waitFor(() => calls === 2);
  const active = fx.router.ledger.database.prepare("SELECT id FROM requests WHERE outcome='running'").get()!;
  const cancellation = await fetch(`${fx.origin}/v1/requests/${String(active.id)}/cancel`, { method: "POST", headers: fx.headers });
  expect(await cancellation.json()).toMatchObject({ cancellationRequested: true, upstreamTerminationConfirmed: false });
  await second; await waitFor(() => fx.router.ledger.request(String(active.id)).outcome !== "running");
  expect(fx.router.ledger.request(String(active.id))).toMatchObject({ execution: "outcome_unknown", accounting: "reconciliation_required", occupied: 1 });
});

it("normalizes overlapping token detail fields without double charging duplicate completion observations", async () => {
  const fx = await fixture((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ status: "completed", model: "reviewed-model", usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 4 } } })); });
  const response = await fx.request(); await response.text(); const id = response.headers.get("x-dim-request-id")!;
  fx.router.ledger.finish(id, { outcome: "completed", captureComplete: true, usage: { inputTokens: 100, outputTokens: 100, raw: {}, source: "backend-response" } });
  expect(fx.router.ledger.usage(fx.workspace.id)).toMatchObject({ requests: 1, knownInputTokens: 10, knownOutputTokens: 5 });
  expect(fx.router.ledger.request(id).raw_usage).toContain('"cached_tokens":8');
});

it("backs up private credentials, ledger, captures and unresolved reservations without replay on restore", async () => {
  let calls = 0;
  const fx = await fixture((_request, response) => { calls++; completed(response); });
  const response = await fx.request(); await response.text(); const completedId = response.headers.get("x-dim-request-id")!;
  const credentials = join(fx.root, "backend-auth"); await mkdir(credentials, { mode: 0o700 }); await writeFile(join(credentials, "account.json"), '{"refresh_token":"inert-test-token"}', { mode: 0o600 });
  const account = fx.config.accounts[0]!; account.credentialDirectory = credentials;
  const grant = fx.router.ledger.authenticate(fx.token)!;
  const { id } = fx.router.ledger.reserve(grant, "reviewed-model", "policy", 10, fx.config.limits, { accountId: "default" }); fx.router.ledger.dispatch(id);
  const snapshot = join(fx.root, "backup");
  await expect(backupRouter(fx.config, snapshot, { backendStateQuiesced: true })).rejects.toThrow(/stop the LLM router/);
  await fx.router.close();
  await expect(backupRouter(fx.config, snapshot)).rejects.toThrow(/stop configured backend credential writers/);
  await backupRouter(fx.config, snapshot, { backendStateQuiesced: true });
  const file = await restoreRouter(snapshot, join(fx.root, "restored"), fx.store.root);
  const restoredConfig = await (await import("../../../../plugin-llm-router/src/config.js")).loadConfig(file);
  expect(await readFile(join(restoredConfig.accounts[0]!.credentialDirectory!, "account.json"), "utf8")).toContain("inert-test-token");
  const restored = await createRouter(restoredConfig); cleanup.push(() => restored.close()); const origin = await listen(restored.server);
  expect(restored.ledger.request(id)).toMatchObject({ execution: "outcome_unknown", occupied: 1, accounting: "reconciliation_required" });
  expect(await captureBody(restored.ledger, completedId, "response")).toEqual(await readFile(join(fx.config.stateDirectory, "captures", completedId, "response.body")));
  expect(calls).toBe(1);
  expect((await fetch(`${origin}/v1/usage`, { headers: fx.headers })).status).toBe(200); expect(calls).toBe(1);
  await writeFile(join(snapshot, "accounts/default/access.key"), "tampered", { mode: 0o600 });
  await expect(restoreRouter(snapshot, join(fx.root, "tampered-restore"), fx.store.root)).rejects.toThrow(/integrity/);
});

it("reports backend authentication health without making inference or claiming provider quota", async () => {
  let models = 0, calls = 0;
  const fx = await fixture((request, response) => { if (request.url === "/v1/models") { models++; response.writeHead(401).end(); } else { calls++; completed(response); } });
  expect(await accountHealth(fx.config)).toMatchObject([{ accountId: "default", backendAuthentication: "reauthorization_or_access_key_required", providerQuota: "unknown", billableInferencePerformed: false }]);
  expect(models).toBe(1); expect(calls).toBe(0);
  await (await fx.request()).text(); expect(calls).toBe(1);
});

it("keeps concurrent account routes isolated and an expired backend account does not disable other accounts", async () => {
  const seen: string[] = [];
  const fx = await fixture((request, response) => { seen.push(request.headers.authorization ?? ""); response.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"account needs reauthorization"}}'); });
  const secondKey = join(fx.root, "second.key"); await writeFile(secondKey, "second-account-key", { mode: 0o600 });
  const backend = createServer((request, response) => { seen.push(request.headers.authorization ?? ""); completed(response); });
  const endpoint = await listen(backend); cleanup.push(async () => { backend.closeAllConnections(); await new Promise<void>((resolve) => backend.close(() => resolve())); });
  fx.config.accounts.push({ id: "second", reference: "second-exclusive-account", endpoint, keyFile: secondKey });
  fx.config.routes.push({ id: "second", accountId: "second", models: fx.config.routes[0]!.models });
  const workspace = workspaceRecord("second-account-workspace"); await fx.store.write(workspace);
  fx.router.ledger.createProject("second-app", { allowedRoutes: ["second"], limits: defaultLimits, captureMode: "required", tokenMode: "observe" });
  const token = fx.router.ledger.issue(workspace, "second", "second-app");
  const [expired, healthy] = await Promise.all([fx.request(), fx.request({}, { ...fx.headers, authorization: `Bearer ${token}` })]);
  expect(expired.status).toBe(401); expect(expired.headers.get("x-dim-error-category")).toBe("account_unavailable"); expect(await expired.text()).toContain("reauthorization");
  expect(healthy.status).toBe(200); await healthy.text();
  expect(seen.sort()).toEqual([`Bearer ${fx.upstreamKey}`, "Bearer second-account-key"].sort());
  expect(fx.router.ledger.database.prepare("SELECT DISTINCT account_id FROM requests ORDER BY account_id").all()).toEqual([{ account_id: "default" }, { account_id: "second" }]);
  expect(fx.router.ledger.project("second-app").enabled).toBe(true);
});

it.each(["required", "best-effort"] as const)("handles %s capture exhaustion during an ordered stream", async (mode) => {
  const first = 'data: {"type":"response.output_text.delta","delta":"preserved-prefix"}\n\n';
  const last = 'data: {"type":"response.completed","response":{"model":"reviewed-model","usage":{"input_tokens":3,"output_tokens":2}}}\n\n';
  const requestBytes = Buffer.byteLength(JSON.stringify({ model: "reviewed-model", input: [{ role: "user", content: "hello" }], stream: true }));
  const fx = await fixture((_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(first); setTimeout(() => response.end(last), 30); }, { captureBytesPerProject: requestBytes + Buffer.byteLength(first) + 1 });
  fx.router.ledger.updatePolicy(fx.workspace.id, { allowedRoutes: ["default"], limits: fx.config.limits, captureMode: mode, tokenMode: "observe" });
  const response = await fx.request({ stream: true });
  if (mode === "required") await expect(response.text()).rejects.toThrow(); else expect(await response.text()).toBe(first + last);
  const row = fx.router.ledger.database.prepare("SELECT * FROM requests").get()!;
  expect(row.capture_complete).toBe(0); expect(row.capture_state).toBe("failed");
  expect(row.accounting).toBe(mode === "required" ? "reconciliation_required" : "settled");
  expect(captureManifest(fx.router.ledger, String(row.id))).toMatchObject({ capture: { complete: false, state: "failed" } });
});

it("recovers a real killed router process without replaying or freeing ambiguous upstream work", async () => {
  let calls = 0;
  const fx = await fixture((_request, response) => { calls++; response.writeHead(200, { "content-type": "text/event-stream" }); response.write('data: {"type":"response.output_text.delta","delta":"started"}\n\n'); }, { concurrent: 1 });
  fx.router.ledger.updatePolicy(fx.workspace.id, { allowedRoutes: ["default"], limits: fx.config.limits, captureMode: "required", tokenMode: "estimate", tokensPerUtcDay: 100, estimatedTokensPerRequest: 60 });
  await fx.router.close();
  const configuration = join(fx.root, "router.json"); await writeFile(configuration, JSON.stringify(fx.config), { mode: 0o600 });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const {loadConfig}=await import(${JSON.stringify(new URL("../../../../plugin-llm-router/dist/config.js", import.meta.url).href)});
    const {createRouter}=await import(${JSON.stringify(new URL("../../../../plugin-llm-router/dist/server.js", import.meta.url).href)});
    const router=await createRouter(await loadConfig(process.argv[1]));router.server.listen(0,'127.0.0.1',()=>console.log(router.server.address().port));
  `, configuration], { stdio: ["ignore", "pipe", "pipe"] });
  let diagnostic = ""; child.stderr.setEncoding("utf8").on("data", (chunk: string) => { diagnostic += chunk; });
  const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
  try {
    const port = await new Promise<number>((resolve, reject) => { child.stdout.setEncoding("utf8"); let output = ""; child.stdout.on("data", (chunk: string) => { output += chunk; if (/^\d+\n$/.test(output)) resolve(Number(output)); }); child.once("close", () => reject(new Error(diagnostic))); });
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: fx.headers, body: JSON.stringify({ model: "reviewed-model", input: [], stream: true }) });
    const reader = response.body!.getReader(); await reader.read(); child.kill("SIGKILL"); await closed; await reader.cancel().catch(() => {});
    const recovered = await createRouter(fx.config); cleanup.push(() => recovered.close()); const origin = await listen(recovered.server);
    const row = recovered.ledger.database.prepare("SELECT * FROM requests").get()!;
    expect(row).toMatchObject({ execution: "outcome_unknown", outcome: "uncertain", occupied: 1, token_reservation: 60, accounting: "reconciliation_required", capture_state: "partial" });
    expect((await fetch(`${origin}/v1/responses`, { method: "POST", headers: fx.headers, body: JSON.stringify({ model: "reviewed-model", input: [] }) })).status).toBe(429);
    expect(calls).toBe(1);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } }
});

it("revalidates rotated principal authority and cancellation at the durable dispatch boundary", async () => {
  const fx = await fixture((_request, response) => completed(response));
  const old = fx.router.ledger.authenticate(fx.token)!;
  fx.router.ledger.issue(fx.workspace, "default", fx.workspace.id);
  expect(() => fx.router.ledger.reserve(old, "reviewed-model", "policy", 10, fx.config.limits, { accountId: "default" })).toThrow(/revoked/);
  const token = fx.router.ledger.issue(fx.workspace, "default", fx.workspace.id), grant = fx.router.ledger.authenticate(token)!;
  const { id } = fx.router.ledger.reserve(grant, "reviewed-model", "policy", 10, fx.config.limits, { accountId: "default" });
  fx.router.ledger.cancel(id); expect(() => fx.router.ledger.dispatch(id)).toThrow(/cancelled before dispatch/);
  expect(fx.router.ledger.request(id).dispatched).toBe(0);
});

it("retains unverified raw usage without guessing numeric totals", async () => {
  const fx = await fixture((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ status: "completed", model: "reviewed-model", usage: { input_tokens: "unverified", output_tokens: 3, custom_usage: "retained" } })); });
  const response = await fx.request(); await response.text(); const id = response.headers.get("x-dim-request-id")!;
  expect(fx.router.ledger.request(id)).toMatchObject({ input_tokens: null, accounting: "reconciliation_required" });
  expect(fx.router.ledger.request(id).raw_usage).toContain('"custom_usage":"retained"');
});

it("does not erase unresolved observe-only consumption when enabling an estimated token budget", async () => {
  const fx = await fixture((_request, response) => { response.writeHead(200, { "content-type": "application/json" }).end('{"status":"completed","model":"reviewed-model"}'); });
  await (await fx.request()).text();
  fx.router.ledger.updatePolicy(fx.workspace.id, { allowedRoutes: ["default"], limits: fx.config.limits, captureMode: "required", tokenMode: "estimate", tokensPerUtcDay: 100, estimatedTokensPerRequest: 60 });
  const response = await fx.request(); expect(response.status).toBe(429); expect(await response.text()).toContain("prior unbounded usage needs reconciliation");
  const status = await (await fetch(`${fx.origin}/v1/usage`, { headers: fx.headers })).json();
  expect(status).toMatchObject({ allowance: { unknownUnreservedRequests: 1, tokenMode: "estimate", remainingEstimatedTokens: null }, unknownUsageRequests: 1 });
});

it("books delayed settlement to its original UTC day and retains physical uncertainty across midnight", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-llm-utc-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  let now = Date.parse("2026-10-18T23:59:59Z"); const ledger = new RouterLedger(join(root, "state"), () => now); cleanup.push(async () => ledger.close());
  ledger.createProject("application", { allowedRoutes: ["default"], limits: { ...defaultLimits, concurrent: 1 }, captureMode: "required", tokenMode: "estimate", tokensPerUtcDay: 100, estimatedTokensPerRequest: 60 });
  const token = ledger.issue(workspaceRecord(), "default", "application"); const grant = ledger.authenticate(token)!;
  const { id } = ledger.reserve(grant, "reviewed-model", "policy", 10, defaultLimits, { accountId: "default" }); ledger.dispatch(id);
  now += 2000; ledger.recoverInterrupted();
  expect(ledger.usage("application")).toMatchObject({ allowance: { utcDay: "2026-10-19", admittedRequests: 0 }, occupied: 1, tokenReservations: 60 });
  expect(() => ledger.reserve(grant, "reviewed-model", "policy", 10, defaultLimits, { accountId: "default" })).toThrow(/concurrency/);
  ledger.resolve(id, { inputTokens: 10, outputTokens: 5, raw: { fixture: true }, source: "operator-resolution" });
  expect(ledger.request(id).day).toBe("2026-10-18"); expect(ledger.usage("application")).toMatchObject({ allowance: { chargedTokensOrEstimates: 0 }, knownInputTokens: 10 });
});

it("observes multiline SSE JSON and split UTF-8 without changing its wire framing", async () => {
  const bytes = Buffer.from(': keepalive\r\nevent: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":{"model":"reviewed-model","label":"한글","usage":{"input_tokens":9,"output_tokens":4}}}\r\n\r\n');
  const split = bytes.indexOf(Buffer.from("한")) + 1;
  const fx = await fixture((_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(bytes.subarray(0, split)); setTimeout(() => response.end(bytes.subarray(split)), 10); });
  const response = await fx.request({ stream: true }); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(fx.router.ledger.usage(fx.workspace.id)).toMatchObject({ knownInputTokens: 9, knownOutputTokens: 4 });
});

it("fails an unexpected observed model visibly while preserving completed execution, usage and capture facts", async () => {
  const fx = await fixture((_request, response) => { response.writeHead(200, { "content-type": "application/json" }).end('{"status":"completed","model":"unreviewed-substitution","usage":{"input_tokens":2,"output_tokens":1}}'); });
  await expect(fx.request().then((response) => response.text())).rejects.toThrow();
  expect(fx.router.ledger.database.prepare("SELECT outcome,execution,delivery,accounting,capture_complete,observed_model,error_code,occupied FROM requests").get()).toMatchObject({
    outcome: "failed", execution: "failed", delivery: "partial", accounting: "settled", capture_complete: 1,
    observed_model: "unreviewed-substitution", error_code: "upstream_policy_violation", occupied: 0
  });
});
