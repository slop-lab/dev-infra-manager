import { expect, it } from "vitest";
import { parseTaskReceipt, parseTaskRequest, taskReceipt } from "../../../../packages/host/plugins/agent-tools/src/execution/taskContract.ts";
import { readTaskInput } from "../../../../packages/host/plugins/agent-tools/src/execution/taskInput.ts";
const request = () => parseTaskRequest({ workspaceId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", requestId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", runtime: "opencode", serverIdentity: "a".repeat(64), target: { kind: "new" }, mode: "record-only", text: "Explicit fixture input" });
it("rejects preference overrides and oversized escaped input before any delivery", () => {
  expect(() => parseTaskRequest({ ...request(), agent: "changed" })).toThrow();
  expect(() => parseTaskRequest({ ...request(), text: "\u0000".repeat(8192) })).toThrow();
});
it("preserves exact UTF-8 task bytes split across chunks and rejects invalid encoding", async () => {
  const value = { text: "Explicit transport: 한글 é 🌍" }, bytes = Buffer.from(JSON.stringify(value));
  async function* chunks() { for (const byte of bytes) yield Uint8Array.of(byte); }
  expect(await readTaskInput(chunks())).toEqual(value);
  async function* invalid() { yield Uint8Array.of(0xc3, 0x28); }
  await expect(readTaskInput(invalid())).rejects.toThrow();
});
it("rejects contradictory outcome states and request-derived message identities", () => {
  const initial = taskReceipt(request());
  for (const change of [{ outcome: "rejected", phase: "complete", reason: "accepted" }, { outcome: "not-found", phase: "message" }, { outcome: "outcome-unknown", phase: "complete" }, { messageId: "msg_" + "c".repeat(32) }]) expect(() => parseTaskReceipt({ ...initial, ...change })).toThrow();
});
