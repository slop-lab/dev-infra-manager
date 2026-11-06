import { once } from "node:events";
import { expect, it } from "vitest";
import { deterministicProvider, fixtureModel } from "./provider.js";

it("requires the actual file-read result before requesting the write and then emits settled protocol usage", async () => {
  const server = deterministicProvider("fixture-key"); server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture has no listener");
    const url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    const send = (messages: unknown[]) => fetch(url, { method: "POST", headers: { authorization: "Bearer fixture-key", "content-type": "application/json" }, body: JSON.stringify({ model: fixtureModel, messages,
      tools: ["read", "write"].map((name) => ({ type: "function", function: { name } })) }) }).then((response) => response.json());
    const initial = await send([]);
    expect(initial).toMatchObject({ choices: [{ message: { tool_calls: [{ function: { name: "read" } }] } }] });
    const afterRead = await send([{ role: "tool", tool_call_id: "call_dim_ci_read", content: `1: ${"d".repeat(32)}` }]);
    expect(afterRead).toMatchObject({ choices: [{ message: { tool_calls: [{ function: { name: "write", arguments: JSON.stringify({ filePath: "/workspace/selected-host-llm.txt", content: `${"d".repeat(32)}\n` }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const complete = await send([{ role: "tool", tool_call_id: "call_dim_ci_write", content: "written by the consumer tool" }]);
    expect(complete).toMatchObject({ choices: [{ finish_reason: "stop" }] });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
