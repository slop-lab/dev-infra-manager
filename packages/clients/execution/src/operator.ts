import { isAbsolute } from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { executionOperatorConnectionSchema } from "@slop-lab/dim-contracts-execution/connections";
import { scheduledSummarySchema, executionWorkersSchema } from "./schemas.js";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";

export async function createExecutionOperatorClient(file: string) {
  if (!isAbsolute(file)) throw new Error("Execution operator connection path must be absolute");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let connection: z.infer<typeof executionOperatorConnectionSchema>;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 16 * 1024) throw new Error("Execution operator connection must be private");
    connection = executionOperatorConnectionSchema.parse(JSON.parse(await handle.readFile("utf8")));
  } finally { await handle.close(); }
  const http = createNodeNativeGitAdmissionHttpClient();
  async function request(path: string, body?: unknown): Promise<unknown> {
    const result = await http.request({ endpoint: connection.endpoint, path, method: body === undefined ? "GET" : "POST",
      generationId: connection.generationId, authorization: `Basic ${Buffer.from(`${connection.credential.username}:${connection.credential.password}`).toString("base64")}`,
      signal: AbortSignal.timeout(10_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (result.statusCode === 409) throw new Error("Execution operation conflicts with the current generation or execution state");
    if (result.statusCode !== 200 || result.contentType !== "application/json" || result.cacheControl !== "no-store") throw new Error("Execution operator service unavailable");
    return JSON.parse(result.body.toString("utf8"));
  }
  const id = (value: string) => z.string().uuid().parse(value);
  return {
    async workers() { return executionWorkersSchema.parse(await request("/v1/operator/workers")); },
    async cancel(executionId: string) { return scheduledSummarySchema.parse(await request(`/v1/operator/jobs/${id(executionId)}/cancel`, {})); },
    async retry(executionId: string, requestId: string) { return scheduledSummarySchema.parse(await request(`/v1/operator/jobs/${id(executionId)}/retry`, { requestId: id(requestId) })); }
  };
}
