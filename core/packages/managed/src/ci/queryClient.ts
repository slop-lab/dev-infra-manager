import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { UserError } from "@slop-lab/dim-core";
import { executionCredentialSchema } from "@slop-lab/dim-native-git/execution";
import { selectedControlPlaneHostFile } from "../controlPlaneSelection.js";
import { createNodeNativeGitAdmissionHttpClient } from "../nativeGitAdmissionHttpClient.js";
import { executionSummarySchema, executionDetailSchema } from "./query.js";

export const ciQueryConnectionSchema = z.object({ schemaVersion: z.literal(1), role: z.literal("query"),
  endpoint: z.string().refine((value) => { try { const url = new URL(value); return url.origin === value
    && !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)); } catch { return false; } }),
  generationId: z.string().regex(/^[0-9a-f]{64}$/), credential: executionCredentialSchema
}).strict();
export type CiQueryConnection = z.infer<typeof ciQueryConnectionSchema>;

export async function createCiQueryClient(override?: string, environment: NodeJS.ProcessEnv = process.env) {
  const file = override === undefined ? path.join(path.dirname(await selectedControlPlaneHostFile(environment)), "ci-query.json") : path.resolve(override);
  let connection: CiQueryConnection;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600
        || stat.nlink !== 1 || stat.size > 16 * 1024) throw new Error("connection must be private");
      connection = ciQueryConnectionSchema.parse(JSON.parse(await handle.readFile("utf8")));
    } finally { await handle.close(); }
  } catch (error) { throw new UserError(`cannot load private CI query connection '${file}'; run 'dim managed control-plane connect SETUP' or select --connection FILE`, { cause: error }); }
  const http = createNodeNativeGitAdmissionHttpClient();
  async function request(target: string): Promise<unknown> {
    let response;
    try { response = await http.request({ endpoint: connection.endpoint, path: target, method: "GET",
      generationId: connection.generationId, authorization: `Basic ${Buffer.from(`${connection.credential.username}:${connection.credential.password}`).toString("base64")}`,
      signal: AbortSignal.timeout(10_000) }); }
    catch (error) { throw new UserError(`CI service is unavailable at ${connection.endpoint}`, { cause: error }); }
    if (response.statusCode === 409) throw new UserError("CI connection generation is stale; finish the control-plane upgrade and reconnect");
    if (response.statusCode === 404) throw new UserError("CI execution was not found");
    if (response.statusCode === 401) throw new UserError("CI query credential was rejected; reconnect the control plane");
    if (response.statusCode !== 200 || response.contentType !== "application/json" || response.cacheControl !== "no-store") throw new UserError("CI query is unavailable");
    try { return JSON.parse(response.body.toString("utf8")); } catch { throw new UserError("CI returned an invalid query response"); }
  }
  return {
    async jobs() {
      const value = z.array(executionSummarySchema).max(100).safeParse(await request("/v1/jobs"));
      if (!value.success) throw new UserError("CI returned invalid execution summaries");
      return value.data;
    },
    async detail(id: string) {
      if (!z.string().uuid().safeParse(id).success) throw new UserError("execution ID must be a UUID");
      const value = executionDetailSchema.safeParse(await request(`/v1/jobs/${id}`));
      if (!value.success) throw new UserError("CI returned an invalid execution detail");
      return value.data;
    }
  };
}
