import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { z } from "zod";
import { operationDescriptors } from "@slop-lab/dim-contracts-operations";
import { capabilitiesSchema, llmOperation, llmOperations } from "@slop-lab/dim-contracts-llm-router";
export class LlmRouterResultUnavailableError extends Error {
  readonly name = "LlmRouterResultUnavailableError";
  constructor(cause?: unknown) {
    super("LLM router operation result unavailable; refresh current state before retrying", { cause });
  }
}
export async function privateOperatorFile(path: string, maximum = 64 * 1024): Promise<string> {
  if (!isAbsolute(path)) throw new Error("operator files require absolute paths");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const info = await file.stat(); if (!info.isFile() || info.nlink !== 1 || info.uid !== process.geteuid?.() || (info.mode & 0o777) !== 0o600 || info.size > maximum) throw new Error("operator inputs must be owned mode-0600 regular files"); return await file.readFile("utf8"); } finally { await file.close(); }
}
const connectionSchema = z.strictObject({ schemaVersion: z.literal(1), endpoint: z.string(), actorId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), keyFile: z.string().refine(isAbsolute) });
/** The selection identity identifies operator authority, independently of any deployment generation. */
export async function attestLlmRouterOperatorConnection(connectionFile: string) {
  const connection = connectionSchema.parse(JSON.parse(await privateOperatorFile(connectionFile)) as unknown), endpoint = new URL(connection.endpoint);
  if (connection.endpoint !== endpoint.origin || endpoint.username || endpoint.password || !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && isIP(endpoint.hostname.replace(/^\[|\]$/g, "")))) throw new Error("operator endpoint must be an HTTPS origin or explicit HTTP IP origin");
  const key = (await privateOperatorFile(connection.keyFile, 16 * 1024)).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("invalid operator credential");
  const selectionId = createHash("sha256").update("dim-llm-router-operator-selection-v1\0").update(JSON.stringify({ endpoint: connection.endpoint, actorId: connection.actorId, key })).digest("hex");
  return { connection, key, selectionId };
}
export function createLlmRouterClient(connectionFile: string, options: { signal?: AbortSignal; expectedSelectionId?: string } = {}) {
  return {
    operations: () => operationDescriptors(llmOperations),
    async selectionId() { return (await attestLlmRouterOperatorConnection(connectionFile)).selectionId; },
    async capabilities() { return capabilitiesSchema.parse(await this.invoke("capabilities", {})); },
    async invoke(name: string, input: unknown): Promise<unknown> {
      const operation = llmOperation(name), payload = operation.parseInput(input);
      const { connection, key, selectionId } = await attestLlmRouterOperatorConnection(connectionFile);
      if (options.expectedSelectionId !== undefined && options.expectedSelectionId !== selectionId) throw new Error("LLM router operator selection changed; reconnect before continuing");
      let response: Response;
      try { response = await fetch(`${connection.endpoint}/v1/operator/operations/${name}`, { method: "POST", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(name === "account.login.start" ? 30_000 : 15_000), ...(options.signal === undefined ? [] : [options.signal])]), headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${connection.actorId}:${key}`).toString("base64")}` }, body: JSON.stringify(payload) }); } catch (error) { throw new LlmRouterResultUnavailableError(error); }
      if (!response.ok) {
        const failure = response.status >= 500 ? new LlmRouterResultUnavailableError() : new Error(response.status === 401 ? "LLM router operator authentication failed" : response.status === 403 ? "LLM router operator permission denied" : `LLM router operation failed (HTTP ${response.status})`);
        try { await response.body?.cancel(); } finally { throw failure; }
      }
      try {
        const reader = response.body?.getReader(); if (!reader) throw new LlmRouterResultUnavailableError();
        const chunks: Uint8Array[] = []; let size = 0;
        try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 2 * 1024 * 1024) throw new Error("LLM router response exceeds operation bound"); chunks.push(next.value); } } finally { await reader.cancel(); }
        const output: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return operation.parseOutput(output);
      } catch (error) {
        if (error instanceof LlmRouterResultUnavailableError) throw error;
        throw new LlmRouterResultUnavailableError(error);
      }
    }
  };
}
