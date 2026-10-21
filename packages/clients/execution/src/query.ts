import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ciQueryConnectionSchema, type CiQueryConnection } from "@slop-lab/dim-contracts-ci/connections";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import { executionSummarySchema, executionDetailSchema } from "@slop-lab/dim-contracts-ci/query";

export async function createCiQueryClient(file: string) {
  if (!isAbsolute(file)) throw new Error("CI query connection path must be absolute");
  let connection: CiQueryConnection;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600
        || stat.nlink !== 1 || stat.size > 16 * 1024) throw new Error("connection must be private");
      connection = ciQueryConnectionSchema.parse(JSON.parse(await handle.readFile("utf8")));
    } finally { await handle.close(); }
  } catch (error) { throw new Error(`cannot load private CI query connection '${file}'`, { cause: error }); }
  const http = createNodeNativeGitAdmissionHttpClient();
  async function request(target: string): Promise<unknown> {
    let response;
    try { response = await http.request({ endpoint: connection.endpoint, path: target, method: "GET",
      generationId: connection.generationId, authorization: `Basic ${Buffer.from(`${connection.credential.username}:${connection.credential.password}`).toString("base64")}`,
      signal: AbortSignal.timeout(10_000) }); }
    catch (error) { throw new Error(`CI service is unavailable at ${connection.endpoint}`, { cause: error }); }
    if (response.statusCode === 409) throw new Error("CI connection generation is stale; finish the control-plane upgrade and reconnect");
    if (response.statusCode === 404) throw new Error("CI execution was not found");
    if (response.statusCode === 401) throw new Error("CI query credential was rejected; reconnect the control plane");
    if (response.statusCode !== 200 || response.contentType !== "application/json" || response.cacheControl !== "no-store") throw new Error("CI query is unavailable");
    try { return JSON.parse(response.body.toString("utf8")); } catch { throw new Error("CI returned an invalid query response"); }
  }
  return {
    async jobs() {
      const value = z.array(executionSummarySchema).max(100).safeParse(await request("/v1/jobs"));
      if (!value.success) throw new Error("CI returned invalid execution summaries");
      return value.data;
    },
    async detail(id: string) {
      if (!z.string().uuid().safeParse(id).success) throw new Error("execution ID must be a UUID");
      const value = executionDetailSchema.safeParse(await request(`/v1/jobs/${id}`));
      if (!value.success) throw new Error("CI returned an invalid execution detail");
      return value.data;
    }
  };
}
