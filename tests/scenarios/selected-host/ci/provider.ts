import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const fixtureModel = "dim-ci-file-model";
/** TEST ONLY: deterministic protocol/tool fixture, never provider/account qualification. */
export function deterministicProvider(key: string, workspace = "/workspace") {
  return createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${key}`) { response.writeHead(401).end(); return; }
      if (request.method === "GET" && request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: fixtureModel, object: "model" }] })); return; }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions" || request.headers["x-dim-request-nonce"] !== undefined) { response.writeHead(400).end(); return; }
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > 2 * 1024 * 1024) throw new Error("fixture request exceeds bound"); chunks.push(bytes); }
      const payload = object(JSON.parse(Buffer.concat(chunks).toString()));
      if (payload.model !== fixtureModel || !Array.isArray(payload.messages)) throw new Error("fixture requires the explicit CI model and messages");
      const messages = payload.messages.map(object), outputs = messages.filter((message) => message.role === "tool");
      const tools = Array.isArray(payload.tools) ? payload.tools.map(object).map((tool) => object(tool.function)) : [];
      const read = tools.find((tool) => tool.name === "read"), write = tools.find((tool) => tool.name === "write"), patch = tools.find((tool) => tool.name === "apply_patch");
      let call: { readonly id: string; readonly type: string; readonly function: { readonly name: string; readonly arguments: string } } | undefined;
      if (read !== undefined && outputs.length === 0) call = { id: "call_dim_ci_read", type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: join(workspace, "selected-host-input.txt") }) } };
      else if (read !== undefined && !outputs.some((message) => message.tool_call_id === "call_dim_ci_write")) {
        const result = outputs.find((message) => message.tool_call_id === "call_dim_ci_read");
        const token = /\b[a-f0-9]{32}\b/.exec(JSON.stringify(result?.content) ?? "")?.[0];
        if (!token) throw new Error("fixture did not receive the actual file-read result");
        if (write !== undefined) call = { id: "call_dim_ci_write", type: "function", function: { name: "write", arguments: JSON.stringify({ filePath: join(workspace, "selected-host-llm.txt"), content: `${token}\n` }) } };
        else if (patch !== undefined) call = { id: "call_dim_ci_write", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ patchText: `*** Begin Patch\n*** Add File: ${join(workspace, "selected-host-llm.txt")}\n+${token}\n*** End Patch` }) } };
        else throw new Error("fixture requires an actual file-write tool");
      }
      const id = `chatcmpl-${randomUUID()}`, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      const delta = call === undefined ? { role: "assistant", content: "DIM deterministic CI fixture completed." } : { role: "assistant", tool_calls: [{ index: 0, ...call }] };
      if (payload.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
        chunk({ id, object: "chat.completion.chunk", created: 1, model: fixtureModel, choices: [{ index: 0, delta, finish_reason: null }] });
        chunk({ id, object: "chat.completion.chunk", created: 1, model: fixtureModel, choices: [{ index: 0, delta: {}, finish_reason: call === undefined ? "stop" : "tool_calls" }], usage });
        response.end("data: [DONE]\n\n");
      } else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id, object: "chat.completion", created: 1, model: fixtureModel,
          choices: [{ index: 0, message: call === undefined ? delta : { role: "assistant", content: null, tool_calls: [call] }, finish_reason: call === undefined ? "stop" : "tool_calls" }], usage }));
      }
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end("test-only provider protocol rejected the request"); });
  });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid deterministic fixture payload");
  return Object.fromEntries(Object.entries(value));
}
