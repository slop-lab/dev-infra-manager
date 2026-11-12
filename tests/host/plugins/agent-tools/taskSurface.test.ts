import { expect, it } from "vitest";
import { taskSurfaceFixture, workspaceId } from "./taskSurfaceFixture.ts";
function input(serverIdentity: unknown) { return { workspaceId, requestId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", runtime: "opencode", serverIdentity, target: { kind: "new" }, mode: "record-only", text: "Explicit read-only fixture delivery; no inference" }; }

it("creates once through the copied locked CLI and replays the durable receipt despite lost adapter availability", async () => {
  const fixture = await taskSurfaceFixture();
  try {
    const identity = await fixture.run("identity", { workspaceId, runtime: "opencode" }); expect(identity.code).toBe(0);
    const request = input(JSON.parse(identity.stdout).serverIdentity);
    const created = await fixture.run("submit", request); expect(created.code).toBe(0); expect(JSON.parse(created.stdout)).toMatchObject({ outcome: "accepted", sessionId: "ses_fixture" });
    expect(created.stdout).not.toContain(request.text);
    expect(await fixture.run("submit", request)).toEqual(created);
    const conflict = await fixture.run("submit", { ...request, text: request.text + " changed" }); expect(conflict.code).toBe(2); expect(JSON.parse(conflict.stdout).outcome).toBe("conflict");
    expect(await fixture.calls()).toEqual([
      { path: "/session", method: "POST", body: {}, held: true, directory: fixture.home },
      { path: "/session/ses_fixture/prompt_async", method: "POST", body: { messageID: "msg_bbbbbbbbbbbb4bbbbbbbbbbbbbbbbbbb", parts: [{ type: "text", text: request.text }], noReply: true }, held: true, directory: fixture.home }
    ]);
    await fixture.breakIdentity();
    expect((await fixture.run("request", { workspaceId, requestId: request.requestId })).stdout).toBe(created.stdout);
    expect((await fixture.run("submit", request)).stdout).toBe(created.stdout);
    expect(await fixture.calls()).toHaveLength(2);
  } finally { await fixture.cleanup(); }
});

it("rejects stale workspace/server identities and unsupported runtimes without an HTTP mutation", async () => {
  const fixture = await taskSurfaceFixture();
  try {
    const request = input("0".repeat(64));
    const stale = await fixture.run("submit", request); expect(JSON.parse(stale.stdout)).toMatchObject({ outcome: "rejected", reason: "stale-server" });
    const unsupported = await fixture.run("submit", { ...request, requestId: "ffffffff-ffff-4fff-ffff-ffffffffffff", runtime: "codex" }); expect(JSON.parse(unsupported.stdout)).toMatchObject({ outcome: "unsupported", reason: "unsupported-runtime" });
    const wrongWorkspace = await fixture.run("submit", { ...request, workspaceId: "dddddddd-dddd-4ddd-dddd-dddddddddddd" }); expect(wrongWorkspace.code).toBe(1);
    expect(await fixture.calls()).toHaveLength(0);
  } finally { await fixture.cleanup(); }
});

it("keeps uncertain existing-session messaging guarded across fresh CLI processes", async () => {
  const fixture = await taskSurfaceFixture();
  try {
    const identity = await fixture.run("identity", { workspaceId, runtime: "opencode" }); expect(identity.code).toBe(0);
    await fixture.drop();
    const message = { ...input(JSON.parse(identity.stdout).serverIdentity), target: { kind: "session", sessionId: "ses_fixture" } };
    const lost = await fixture.run("submit", message); expect(lost.code).toBe(2); expect(JSON.parse(lost.stdout)).toMatchObject({ outcome: "outcome-unknown", phase: "message", sessionId: "ses_fixture" });
    const count = (await fixture.calls()).length;
    expect((await fixture.run("submit", message)).stdout).toBe(lost.stdout);
    expect(await fixture.calls()).toHaveLength(count);
    expect(count).toBe(2);
  } finally { await fixture.cleanup(); }
});
