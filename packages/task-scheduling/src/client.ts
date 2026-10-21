import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/** Submit work through the existing scheduler; service authority stays with its issuer. */
export async function runScheduledTask(options: {
  readonly endpoint: string; readonly generationId: string;
  readonly credential: { readonly username: string; readonly password: string };
  readonly taskType: string; readonly handlerRevision: string; readonly payload: unknown;
  readonly exchange: (operation: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal === undefined ? [] : [options.signal])]);
  const authorization = `Basic ${Buffer.from(`${options.credential.username}:${options.credential.password}`).toString("base64")}`;
  async function request(path: string, body?: object, cancel = false): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(path, options.endpoint), { method: body === undefined ? "GET" : "POST",
      headers: { authorization, "x-dim-generation-id": options.generationId, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: cancel ? AbortSignal.timeout(2_000) : signal });
    if (!response.ok || response.headers.get("content-type") !== "application/json" || response.headers.get("cache-control") !== "no-store") throw new Error(`scheduled task request failed (${response.status})`);
    // Replies contain one bounded exchange request or a bounded task result.
    const chunks: Buffer[] = [];
    let size = 0;
    if (response.body !== null) {
      const reader = response.body.getReader();
      try { for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length;
        if (size > 1_500_000) { await reader.cancel(); throw new Error("scheduled task response limit"); }
        chunks.push(Buffer.from(chunk.value));
      } } finally { reader.releaseLock(); }
    }
    const bytes = Buffer.concat(chunks);
    const raw: unknown = JSON.parse(bytes.toString());
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid scheduled task response");
    return raw as Record<string, unknown>;
  }
  let id: string | undefined, completed = false;
  try {
    const accepted = await request("/v1/tasks", { requestId: randomUUID(), taskType: options.taskType, handlerRevision: options.handlerRevision, payload: options.payload });
    if (typeof accepted.executionId !== "string" || !/^[a-f0-9-]{36}$/.test(accepted.executionId) || accepted.generationId !== options.generationId) throw new Error("invalid scheduled task identity");
    id = accepted.executionId;
    for (;;) {
      signal.throwIfAborted();
      const state = await request(`/v1/tasks/${id}/exchange`);
      if (state.result !== undefined) {
        const result = state.result as Record<string, unknown>;
        if (result === null || typeof result !== "object" || result.executionId !== id || result.cleanupComplete !== true || !["success", "failure", "cancelled"].includes(String(result.result))) throw new Error("invalid scheduled task result");
        await request(`/v1/tasks/${id}/complete`, {});
        completed = true;
        if (result.result !== "success") throw new Error("scheduled task failed or was cancelled");
        return result.value;
      }
      if (state.phase === "recovering" || state.phase === "finished") throw new Error("scheduled task requires recovery or re-evaluation");
      if (state.request !== undefined) {
        const read = state.request as Record<string, unknown>;
        if (read === null || typeof read !== "object" || typeof read.operation !== "string" || !Number.isSafeInteger(read.id)) throw new Error("invalid scheduled task exchange");
        const value = await new Promise<unknown>((resolve, reject) => {
          const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) { aborted(); return; }
          Promise.resolve().then(() => options.exchange(read.operation as string, read.input, signal)).then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", aborted));
        });
        signal.throwIfAborted();
        await request(`/v1/tasks/${id}/exchange`, { requestId: read.id, value });
      } else await delay(20, undefined, { signal });
    }
  } finally {
    if (!completed && id !== undefined) { try { await request(`/v1/tasks/${id}/cancel`, {}, true); } catch { /* A lost service already prevents acceptance. */ } }
  }
}

export const taskClientRevision = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
