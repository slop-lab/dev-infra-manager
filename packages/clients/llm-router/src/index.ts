import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import { operationDescriptors } from "@slop-lab/dim-contracts-operations";
import { capabilitiesSchema, llmOperation, llmOperations } from "./operations.js";
export { llmOperation, llmOperations, limitsSchema, policySchema, projectSchema } from "./operations.js";
export async function privateOperatorFile(path: string, maximum = 64 * 1024): Promise<string> {
  if (!isAbsolute(path)) throw new Error("operator files require absolute paths");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const info = await file.stat(); if (!info.isFile() || info.nlink !== 1 || info.uid !== process.geteuid?.() || (info.mode & 0o777) !== 0o600 || info.size > maximum) throw new Error("operator inputs must be owned mode-0600 regular files"); return await file.readFile("utf8"); } finally { await file.close(); }
}
const connectionSchema = z.strictObject({ schemaVersion: z.literal(1), endpoint: z.string(), actorId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), keyFile: z.string().refine(isAbsolute) });
export function createLlmRouterClient(connectionFile: string, options: { signal?: AbortSignal } = {}) {
  return {
    operations: () => operationDescriptors(llmOperations),
    async capabilities() { return capabilitiesSchema.parse(await this.invoke("capabilities", {})); },
    async invoke(name: string, input: unknown): Promise<unknown> {
      const operation = llmOperation(name), payload = operation.parseInput(input);
      const connection = connectionSchema.parse(JSON.parse(await privateOperatorFile(connectionFile)) as unknown), endpoint = new URL(connection.endpoint);
      if (connection.endpoint !== endpoint.origin || endpoint.username || endpoint.password || !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && isIP(endpoint.hostname.replace(/^\[|\]$/g, "")))) throw new Error("operator endpoint must be an HTTPS origin or explicit HTTP IP origin");
      const key = (await privateOperatorFile(connection.keyFile, 16 * 1024)).trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("invalid operator credential");
      let response: Response;
      try { response = await fetch(`${connection.endpoint}/v1/operator/operations/${name}`, { method: "POST", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(options.signal === undefined ? [] : [options.signal])]), headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${connection.actorId}:${key}`).toString("base64")}` }, body: JSON.stringify(payload) }); } catch { throw new Error("LLM router connection unavailable; check the configured endpoint and service"); }
      if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 ? "LLM router operator authentication failed" : response.status === 403 ? "LLM router operator permission denied" : `LLM router operation failed (HTTP ${response.status})`); }
      const reader = response.body?.getReader(); if (!reader) throw new Error("LLM router returned no operation result");
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 2 * 1024 * 1024) throw new Error("LLM router response exceeds operation bound"); chunks.push(next.value); } } finally { await reader.cancel(); }
      return operation.parseOutput(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
    }
  };
}
