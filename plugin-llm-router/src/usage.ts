import { object } from "./config.js";
import type { Usage } from "./ledger.js";

/** Reports only upstream numeric observations; missing/incomplete usage stays unknown. */
export class UsageObserver {
  completed = false;
  failed = false;
  usage: Usage | undefined;
  model: string | undefined;
  private pending = "";
  private decoder = new TextDecoder();
  private total = "";
  constructor(private readonly streaming: boolean) {}
  push(bytes: Uint8Array): void {
    const text = this.decoder.decode(bytes, { stream: true });
    if (!this.streaming) { this.total += text; return; }
    this.pending += text;
    if (this.pending.length > 1024 * 1024) throw new Error("upstream SSE frame exceeds bound");
    for (;;) {
      const end = this.pending.indexOf("\n"); if (end < 0) break;
      const line = this.pending.slice(0, end).trimEnd(); this.pending = this.pending.slice(end + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data === "[DONE]") this.completed = true; else this.observe(data);
      }
    }
  }
  finish(): void {
    const rest = this.decoder.decode();
    if (!this.streaming) this.observe(this.total + rest);
    else if (this.pending.startsWith("data:")) {
      const data = this.pending.slice(5).trim();
      if (data === "[DONE]") this.completed = true; else this.observe(data);
    }
  }
  private observe(source: string): void {
    try {
      const value: unknown = JSON.parse(source), outer = object(value);
      const row = ["response.completed", "response.failed", "response.incomplete"].includes(String(outer.type)) ? object(outer.response) : outer;
      if (outer.type === "response.failed" || outer.type === "response.incomplete" || row.status === "failed" || row.status === "incomplete" || row.error !== undefined) { this.failed = true; this.completed = true; }
      if (outer.type === "response.completed" || !this.streaming && (row.status === "completed" || Array.isArray(row.choices))) this.completed = true;
      if (typeof row.model === "string") this.model = row.model;
      if (row.usage === undefined || row.usage === null) return;
      const usage = object(row.usage);
      const input = usage.input_tokens ?? usage.prompt_tokens, output = usage.output_tokens ?? usage.completion_tokens;
      if (typeof input !== "number" || typeof output !== "number" || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0) return;
      this.usage = { inputTokens: input, outputTokens: output, raw: usage, source: "backend-response" };
    } catch { /* Protocol data without a verified usage observation is not zero usage. */ }
  }
}
