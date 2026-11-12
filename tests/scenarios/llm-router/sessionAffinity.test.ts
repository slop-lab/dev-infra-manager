import { randomBytes, randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import { createRouter } from "../../../packages/control-plane/plugins/llm-router/src/server.js";
import { parseConfig, defaultLimits, backendProfile } from "../../../packages/control-plane/plugins/llm-router/src/config.js";
import { hash } from "../../../packages/control-plane/plugins/llm-router/src/ledger.js";
import { createHostGateway, createAttachment } from "../../../packages/host/plugins/llm-router/src/gateway.js";
import { parseHostConfig } from "../../../packages/host/plugins/llm-router/src/config.js";
import { issuePrincipal } from "../../../packages/host/plugins/llm-router/src/client.js";
import { workspaceRecord } from "../../support/workspaceFixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("missing listener");
  return `http://127.0.0.1:${address.port}`;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-session-affinity-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const calls: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const backend = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks); calls.push({ headers: request.headers, body });
    const input = JSON.parse(body.toString()) as { stream?: boolean };
    const value = request.url === "/v1/chat/completions"
      ? { object: "chat.completion", model: "provider/actual-model", choices: [{ index: 0, message: { role: "assistant", content: "fixture" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }
      : { status: "completed", model: "provider/actual-model", usage: { input_tokens: 2, output_tokens: 1 } };
    response.writeHead(200, { "content-type": input.stream ? "text/event-stream" : "application/json" });
    response.end(input.stream ? request.url === "/v1/chat/completions" ? `: preserved\r\ndata: ${JSON.stringify(value)}\r\n\r\ndata: [DONE]\r\n\r\n` : `: preserved\r\ndata: ${JSON.stringify({ type: "response.completed", response: value })}\r\n\r\n` : JSON.stringify(value));
  })(); });
  const endpoint = await listen(backend); cleanup.push(async () => { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); });
  const issuerKeyFile = join(root, "issuer.key"), keyFile = join(root, "upstream.key");
  await writeFile(issuerKeyFile, randomBytes(32).toString("base64url"), { mode: 0o600 });
  await writeFile(keyFile, "operator-upstream-key", { mode: 0o600 });
  const config = parseConfig({ schemaVersion: 3, stateDirectory: join(root, "cp"), listen: { host: "127.0.0.1", port: 8318 }, backend: backendProfile,
    hostIssuers: [{ id: "host-a", keyFile: issuerKeyFile, projects: ["application", "other-application"].map(id => ({ id, routeIds: ["default"] })) }],
    accounts: [{ id: "default", reference: "static-upstream", endpoint, keyFile }], limits: defaultLimits,
    routes: [{ id: "default", accountId: "default", models: [{ id: "auto/standard", name: "Standard", api: "responses" }, { id: "auto/chat", name: "Chat", api: "chat" }] }] });
  const cp = await createRouter(config), cpOrigin = await listen(cp.server); cleanup.push(() => cp.close());
  for (const project of ["application", "other-application"]) cp.ledger.createProject(project, { allowedRoutes: ["default"], limits: defaultLimits, captureMode: "required", tokenMode: "observe" });
  const store = new WorkspaceStore(join(root, "workspaces"));
  const gatewayConfig = parseHostConfig({ schemaVersion: 1, stateDirectory: join(root, "host"), workspaceStateRoot: store.root,
    connection: { schemaVersion: 1, endpoint: cpOrigin, issuerId: "host-a", issuerKeyFile }, listen: { host: "127.0.0.1", port: 8319 }, publicEndpoint: "http://127.0.0.1:8319" });
  const gateway = await createHostGateway(gatewayConfig, store), gatewayOrigin = await listen(gateway.server); cleanup.push(() => gateway.close());
  async function connect(name = "workspace-a", projectId = "application") {
    const workspace = workspaceRecord(name); await store.write(workspace);
    const scope = { bindingId: randomUUID(), projectId, routeId: "default", workspaceId: workspace.id, workspaceName: workspace.name };
    const principal = await issuePrincipal(gatewayConfig.connection, scope, AbortSignal.timeout(5000));
    const attachment = await createAttachment(gatewayConfig, scope, principal); await attachment.activate();
    return { workspace, principal, token: attachment.token, projectId };
  }
  async function request(connection: Awaited<ReturnType<typeof connect>>, headers: Record<string, string | string[]> = {}, direct = false, stream = false, api: "responses" | "chat" = "responses", model = api === "responses" ? "auto/standard" : "auto/chat") {
    return await new Promise<{ status: number; body: Buffer; requestId?: string }>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const request = httpRequest((direct ? cpOrigin : gatewayOrigin) + (api === "responses" ? "/v1/responses" : "/v1/chat/completions"), { method: "POST", headers: {
        authorization: `Bearer ${direct ? connection.principal.token : connection.token}`, "content-type": "application/json", ...headers
      } }, response => {
        response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.once("error", reject);
        response.once("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks), ...(typeof response.headers["x-dim-request-id"] === "string" ? { requestId: response.headers["x-dim-request-id"] } : {}) }));
      }); request.once("error", reject); request.end(JSON.stringify({ model, ...(api === "responses" ? { input: "fixture" } : { messages: [{ role: "user", content: "fixture" }] }), stream }));
    });
  }
  return { calls, cp, connect, request };
}

it("namespaces an explicit session by project/workspace and preserves affinity across principal reconnects", async () => {
  const f = await fixture(), first = await f.connect();
  const session = "ses_parent.0:standard-test";
  expect((await f.request(first, { "x-dim-session-id": session })).status).toBe(200);
  const reconnected = await f.connect(); expect(reconnected.principal.principalId).not.toBe(first.principal.principalId);
  expect((await f.request(reconnected, { "x-dim-session-id": session })).status).toBe(200);
  expect((await f.request(reconnected, { "x-dim-session-id": "ses_child" })).status).toBe(200);
  const otherWorkspace = await f.connect("workspace-b"); await f.request(otherWorkspace, { "x-dim-session-id": session });
  const otherProject = await f.connect("workspace-a", "other-application"); await f.request(otherProject, { "x-dim-session-id": session });
  const keys = f.calls.map(call => call.headers["x-session-id"]);
  expect(keys[0]).toBe(hash(JSON.stringify(["application", first.workspace.id, session])));
  expect(keys[1]).toBe(keys[0]); expect(new Set([keys[0], keys[2], keys[3], keys[4]]).size).toBe(4);
  expect(f.calls.every(call => call.headers.authorization === "Bearer operator-upstream-key")).toBe(true);
  expect(f.calls.every(call => call.headers["x-dim-session-id"] === undefined)).toBe(true);
});

it("does not fabricate a session or forward caller routing/account credentials", async () => {
  const f = await fixture(), connection = await f.connect();
  for (const direct of [false, true]) {
    expect((await f.request(connection, { "x-session-id": "attacker-affinity", "x-upstream-account": "other", "x-api-key": "caller-key" }, direct)).status).toBe(200);
  }
  for (const call of f.calls) {
    expect(call.headers.authorization).toBe("Bearer operator-upstream-key");
    for (const header of ["x-session-id", "x-dim-session-id", "x-upstream-account", "x-api-key"]) expect(call.headers[header]).toBeUndefined();
  }
});

it.each(["", "contains space", "comma,joined", "slash/path", "s".repeat(201), ["same", "same"]])("rejects malformed or repeated session headers at both trust boundaries: %j", async value => {
  const f = await fixture(), connection = await f.connect();
  for (const direct of [false, true]) expect((await f.request(connection, { "x-dim-session-id": value }, direct)).status).toBe(400);
  expect(f.calls).toHaveLength(0);
  expect(f.cp.ledger.database.prepare("SELECT COUNT(*) AS count FROM requests").get()?.count).toBe(0);
});

it.each([{ stream: false, api: "responses" }, { stream: true, api: "responses" }, { stream: false, api: "chat" }, { stream: true, api: "chat" }] as const)("preserves alias response bytes and requested/observed provenance through the gateway ($api stream=$stream)", async ({ stream, api }) => {
  const f = await fixture(), connection = await f.connect();
  const response = await f.request(connection, { "x-dim-session-id": "s".repeat(200) }, false, stream, api);
  const value = api === "responses" ? { status: "completed", model: "provider/actual-model", usage: { input_tokens: 2, output_tokens: 1 } }
    : { object: "chat.completion", model: "provider/actual-model", choices: [{ index: 0, message: { role: "assistant", content: "fixture" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } };
  expect(response.status).toBe(200);
  expect(response.body.toString()).toBe(stream ? api === "responses" ? `: preserved\r\ndata: ${JSON.stringify({ type: "response.completed", response: value })}\r\n\r\n` : `: preserved\r\ndata: ${JSON.stringify(value)}\r\n\r\ndata: [DONE]\r\n\r\n` : JSON.stringify(value));
  const requested = api === "responses" ? "auto/standard" : "auto/chat";
  expect(JSON.parse(f.calls[0]!.body.toString()).model).toBe(requested);
  expect(f.cp.ledger.request(response.requestId!)).toMatchObject({ requested_model: requested, observed_model: "provider/actual-model", outcome: "completed", delivery: "complete", capture_complete: 1, occupied: 0 });
});


it("keeps authentication and requested-model authorization independent of session affinity", async () => {
  const f = await fixture(), connection = await f.connect();
  for (const direct of [false, true]) {
    expect((await f.request(connection, { authorization: "Bearer invalid", "x-dim-session-id": "ses_valid" }, direct)).status).toBe(401);
    expect((await f.request(connection, { "x-dim-session-id": "ses_valid" }, direct, false, "responses", "provider/actual-model")).status).toBe(403);
  }
  expect((await f.request(connection, { "x-dim-session-id": "ses_valid", "x-dim-project-id": "other-application" }, true)).status).toBe(403);
  expect(f.calls).toHaveLength(0);
});
