import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parseTaskReceipt, parseTaskRequest, taskReceipt } from "../../../../packages/host/plugins/agent-tools/src/execution/taskContract.ts";
import { readTaskInput } from "../../../../packages/host/plugins/agent-tools/src/execution/taskInput.ts";
const request = () => parseTaskRequest({ workspaceId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", requestId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", runtime: "opencode", serverIdentity: "a".repeat(64), target: { kind: "new" }, mode: "record-only", text: "Explicit fixture input" });
it("rejects preference overrides and oversized escaped input before any delivery", () => {
  expect(() => parseTaskRequest({ ...request(), agent: "changed" })).toThrow();
  expect(() => parseTaskRequest({ ...request(), text: "\u0000".repeat(8192) })).toThrow();
});
it("keeps omitted-model canonical input and the existing durable digest unchanged", () => {
  expect(request()).not.toHaveProperty("model");
  expect(createHash("sha256").update("DIM task request v1\0").update(JSON.stringify(request())).digest("hex")).toBe("5884ddbf9290a82184061fd73c3c22da049447327e6a4224d1c5e552cda32a3e");
  expect(parseTaskRequest({ ...request(), runtime: "other" }).runtime).toBe("other");
});
it("canonicalizes a structured OpenCode model while preserving opaque IDs and the byte boundary", () => {
  const model = { modelID: "vendor/model/variant", providerID: "dim-chat" };
  expect(parseTaskRequest({ ...request(), model }).model).toEqual({ providerID: "dim-chat", modelID: "vendor/model/variant" });
  expect(parseTaskRequest({ ...request(), model: { providerID: "p".repeat(256), modelID: "é".repeat(128) } }).model?.modelID).toBe("é".repeat(128));
});
it.each([
  null, undefined, [], "dim-chat/standard", {}, { providerID: "dim-chat" }, { modelID: "standard" },
  { providerID: "dim-chat", modelID: "standard", variant: "high" },
  ...["", " ", " leading", "trailing ", "a\nb", "a\rb", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b", "a\u2028b", "a\u2029b", "\ud800", "a".repeat(257), "é".repeat(129), 1, false].flatMap(value => [
    { providerID: value, modelID: "standard" }, { providerID: "dim-chat", modelID: value }
  ])
])("rejects malformed model input %# without accepting scalar provider/model syntax", model => {
  expect(() => parseTaskRequest({ ...request(), model })).toThrow();
});
it("rejects model selection for a runtime without the OpenCode producer", () => {
  expect(() => parseTaskRequest({ ...request(), runtime: "other", model: { providerID: "dim-chat", modelID: "standard" } })).toThrow();
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
