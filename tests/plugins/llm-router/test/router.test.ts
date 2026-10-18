import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceStore } from "@slop-lab/dim-core/workspace";
import { createRouter } from "../../../../plugin-llm-router/src/server.js";
import { parseConfig, defaultLimits, type RouterConfig } from "../../../../plugin-llm-router/src/config.js";
import { RouterLedger } from "../../../../plugin-llm-router/src/ledger.js";
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
  const config = parseConfig({ schemaVersion: 1, stateDirectory: join(root, "router"), workspaceStateRoot: store.root,
    listen: { host: "127.0.0.1", port: 8318 }, routes: [{ id: "default", endpoint, keyFile, models: [
      { id: "reviewed-model", name: "Reviewed model", api: "responses", context: 10000, output: 1000 }] }], limits: { ...defaultLimits, ...overrides } });
  const router = await createRouter(config); const origin = await listen(router.server);
  cleanup.push(() => router.close());
  const token = router.ledger.issue(workspace, "default");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const request = (extra: object = {}, selectedHeaders: Record<string, string> = headers) => fetch(`${origin}/v1/responses`, { method: "POST", headers: selectedHeaders,
    body: JSON.stringify({ model: "reviewed-model", input: [{ role: "user", content: "hello" }], ...extra }) });
  return { root, router, config, store, workspace, origin, request, headers, upstreamKey, token };
}
function completed(response: ServerResponse) { response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ object: "response", status: "completed", model: "observed-model", output: [], usage: { input_tokens: 7, output_tokens: 3 } })); }
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
  expect(await usage.json()).toMatchObject({ workspaceId: fx.workspace.id, requests: 1, knownInputTokens: 7, knownOutputTokens: 3, unknownUsageRequests: 0 });
  expect(bytes.toString()).not.toContain(fx.upstreamKey);
  const foreign = workspaceRecord("other-workspace"); await fx.store.write(foreign);
  const token = fx.router.ledger.issue(foreign, "default");
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
  fx.router.ledger.issue(fx.workspace, "default"); expect((await fx.request()).status).toBe(401);
  expect(fx.router.ledger.usage(fx.workspace.id)).toMatchObject({ requests: 1 });
  const token = fx.router.ledger.issue(fx.workspace, "default");
  await fx.store.write({ ...fx.workspace, phase: "discarding" });
  expect((await fx.request({}, { ...fx.headers, authorization: `Bearer ${token}` })).status).toBe(401);
});
it("treats interrupted dispatch as uncertain on restart and does not let administrative readers recover a live request", async () => {
  const fx = await fixture((_request, response) => completed(response));
  const grant = fx.router.ledger.authenticate(fx.token)!;
  const id = fx.router.ledger.reserve(grant, "reviewed-model", "policy", 10, defaultLimits);
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
