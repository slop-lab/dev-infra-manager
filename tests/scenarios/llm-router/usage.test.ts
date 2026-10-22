import { expect, it } from "vitest";
import { UsageObserver } from "../../../packages/control-plane/plugins/llm-router/src/usage.js";

it.each(["single line", "multiple data lines"])("observes a fragmented SSE completion larger than 1 MiB with %s", (format) => {
  const response = { model: "large-response", output: "한글🙂".repeat(200_000), usage: { input_tokens: 11, output_tokens: 5 } };
  const data = format === "single line"
    ? `data: ${JSON.stringify({ type: "response.completed", response })}`
    : `data: {"type":"response.completed",\r\ndata: "response":${JSON.stringify(response)}}`;
  const bytes = Buffer.from(`${data}\r\n\r\n`);
  expect(bytes.length).toBeGreaterThan(1024 * 1024);
  const observer = new UsageObserver(true);
  for (let offset = 0; offset < bytes.length; offset += 16_381) observer.push(bytes.subarray(offset, offset + 16_381));
  observer.finish();
  expect(observer.completed).toBe(true);
  expect(observer.failed).toBe(false);
  expect(observer.model).toBe("large-response");
  expect(observer.usage).toMatchObject({ inputTokens: 11, outputTokens: 5, source: "backend-response" });
});

it.each([-1, 1.5, "11", Number.MAX_SAFE_INTEGER])("keeps invalid or overflowing usage unknown after completion (%s)", (input) => {
  const observer = new UsageObserver(true);
  observer.push(Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: input, output_tokens: 5 } } })}\n\n`));
  observer.finish();
  expect(observer.completed).toBe(true);
  expect(observer.usage).toBeUndefined();
});

it("observes failure and the final unterminated event without inventing usage", () => {
  const observer = new UsageObserver(true);
  observer.push(Buffer.from('data: {"type":"response.failed","response":{"model":"failed-model","error":{"message":"upstream failure"}}}'));
  observer.finish();
  expect(observer.completed).toBe(true);
  expect(observer.failed).toBe(true);
  expect(observer.model).toBe("failed-model");
  expect(observer.usage).toBeUndefined();
});
