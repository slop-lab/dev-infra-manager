import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseTaskRequest } from "../../../../packages/host/plugins/agent-tools/src/execution/taskContract.ts";
import { runTaskRequest } from "../../../../packages/host/plugins/agent-tools/src/execution/taskJournal.ts";
import { deliverOpenCodeTask, taskTransport } from "../../../../packages/host/plugins/agent-tools/src/execution/taskHttp.ts";

async function fixture(action: (f: { readonly run: (change?: Record<string, unknown>) => ReturnType<typeof runTaskRequest>; readonly calls: { path: string; method: string; body: unknown }[]; readonly lose: (path: string) => void; readonly replace: () => void; readonly replaceAfterPrompt: () => void; readonly foreignDirectory: () => void }) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "dim-task-http-")), calls: { path: string; method: string; body: unknown }[] = [];
  let lost: string | undefined, changed = false, replaceAfterPrompt = false, foreignDirectory = false;
  const authorization = "Basic fixture-private-authorization";
  const server = createServer((request, response) => { void (async () => {
    if (request.headers.authorization !== authorization) { response.writeHead(401); response.end(); return; }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    expect(url.searchParams.get("directory")).toBe(home);
    let source = ""; for await (const chunk of request) source += chunk.toString();
    const body: unknown = source ? JSON.parse(source) : null; calls.push({ path: url.pathname, method: request.method ?? "", body });
    if (lost === url.pathname) { request.socket.destroy(); return; }
    if (url.pathname.endsWith("/prompt_async")) { if (replaceAfterPrompt) changed = true; response.writeHead(204); response.end(); return; }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ id: "ses_fixture", directory: foreignDirectory ? "/foreign" : home }));
  })().catch(() => response.destroy()); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("Missing task fixture port");
  try {
    const run = (change: Record<string, unknown> = {}) => {
      const input = parseTaskRequest({ workspaceId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", requestId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", runtime: "opencode", serverIdentity: "a".repeat(64), target: { kind: "new" }, mode: "record-only", text: "Explicit wire fixture content", ...change });
      const transport = taskTransport({ origin: `http://127.0.0.1:${address.port}`, directory: home, serverIdentity: input.serverIdentity, authorization, lockFile: "unused" }, AbortSignal.timeout(5000), async () => { if (changed) throw Error("Stale server"); });
      return runTaskRequest(home, input, journal => deliverOpenCodeTask(input, journal, transport));
    };
    await action({ run, calls, lose(path) { lost = path; }, replace() { changed = true; }, replaceAfterPrompt() { replaceAfterPrompt = true; }, foreignDirectory() { foreignDirectory = true; } });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
}
it("creates and sends explicit content once without changing configured agent/model preferences", async () => fixture(async f => {
  const receipt = await f.run(); expect(receipt).toMatchObject({ outcome: "accepted", sessionId: "ses_fixture", phase: "complete", completion: "not-assessed" });
  expect(f.calls).toEqual([{ path: "/session", method: "POST", body: {} }, { path: "/session/ses_fixture/prompt_async", method: "POST", body: { messageID: receipt.messageId, parts: [{ type: "text", text: "Explicit wire fixture content" }], noReply: true } }]);
  expect(await f.run()).toEqual(receipt); expect(f.calls).toHaveLength(2);
  expect((await f.run({ text: "different explicit input" })).outcome).toBe("conflict"); expect(f.calls).toHaveLength(2);
}));
it("resumes or messages an existing exact session without creating another or selecting an agent", async () => fixture(async f => {
  expect((await f.run({ target: { kind: "session", sessionId: "ses_fixture" }, mode: "execute" })).outcome).toBe("accepted");
  expect(f.calls.map(row => [row.method, row.path])).toEqual([["GET", "/session/ses_fixture"], ["POST", "/session/ses_fixture/prompt_async"]]);
  expect(f.calls[1]?.body).not.toHaveProperty("agent"); expect(f.calls[1]?.body).not.toHaveProperty("model"); expect(f.calls[1]?.body).not.toHaveProperty("noReply");
}));
it.each([
  { target: { kind: "new" }, mode: "execute" },
  { target: { kind: "session", sessionId: "ses_fixture" }, mode: "execute" },
  { target: { kind: "new" }, mode: "record-only" }
])("delivers an explicit structured model for $target.kind in $mode mode", async selection => fixture(async f => {
  const model = { providerID: "dim-chat", modelID: "vendor/model/standard" };
  const receipt = await f.run({ ...selection, model });
  expect(receipt.outcome).toBe("accepted");
  expect(f.calls.at(-1)).toEqual({ path: "/session/ses_fixture/prompt_async", method: "POST", body: {
    messageID: receipt.messageId, parts: [{ type: "text", text: "Explicit wire fixture content" }],
    ...(selection.mode === "record-only" ? { noReply: true } : {}), model
  } });
  expect(await f.run({ ...selection, model: { modelID: model.modelID, providerID: model.providerID } })).toEqual(receipt);
  const count = f.calls.length;
  for (const changed of [{ ...model, modelID: "different" }, { ...model, providerID: "other-provider" }]) {
    expect((await f.run({ ...selection, model: changed })).outcome).toBe("conflict");
  }
  expect((await f.run(selection)).outcome).toBe("conflict");
  expect(f.calls).toHaveLength(count);
}));
it("does not reuse an omitted-model request ID to select a model on replay", async () => fixture(async f => {
  expect((await f.run()).outcome).toBe("accepted");
  expect((await f.run({ model: { providerID: "dim-chat", modelID: "standard" } })).outcome).toBe("conflict");
  expect(f.calls).toHaveLength(2);
}));
it("rejects invalid model input before any owned HTTP request", async () => fixture(async f => {
  for (const model of ["dim-chat/standard", { providerID: "dim-chat", modelID: "standard\n" }, { providerID: "dim-chat", modelID: "standard", system: "override" }]) {
    expect(() => f.run({ model })).toThrow();
  }
  expect(() => f.run({ runtime: "other", model: { providerID: "dim-chat", modelID: "standard" } })).toThrow();
  expect(f.calls).toHaveLength(0);
}));
it.each(["/session", "/session/ses_fixture/prompt_async"])("never retries after uncertain network acceptance at %s", async path => fixture(async f => {
  f.lose(path); expect((await f.run()).outcome).toBe("outcome-unknown");
  const count = f.calls.length; expect((await f.run()).outcome).toBe("outcome-unknown"); expect(f.calls).toHaveLength(count);
  expect(f.calls.filter(row => row.path === path)).toHaveLength(1);
}));
it("rejects stale identity before any mutation and keeps the request guarded", async () => fixture(async f => {
  f.replace(); expect((await f.run()).outcome).toBe("outcome-unknown"); await f.run(); expect(f.calls).toHaveLength(0);
}));
it("does not claim acceptance if server identity changes after HTTP 204", async () => fixture(async f => {
  f.replaceAfterPrompt(); expect(await f.run()).toMatchObject({ outcome: "outcome-unknown", phase: "message" }); const count = f.calls.length;
  await f.run(); expect(f.calls).toHaveLength(count);
}));
it("rejects a session in another directory before messaging", async () => fixture(async f => {
  f.foreignDirectory(); expect(await f.run({ target: { kind: "session", sessionId: "ses_fixture" } })).toMatchObject({ outcome: "rejected", reason: "invalid-session" });
  expect(f.calls.map(row => row.method)).toEqual(["GET"]);
}));
