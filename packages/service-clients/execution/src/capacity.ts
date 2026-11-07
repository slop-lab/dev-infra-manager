import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { executionCapacityConnectionSchema, executionCapacityPlanSchema, executionCapacityRequestSchema } from "@slop-lab/dim-contracts-execution";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";

/** Dedicated provider authority: cannot enroll/export workers, query artifacts or cancel jobs. */
export async function createExecutionCapacityClient(file: string) {
  if (!isAbsolute(file)) throw new Error("capacity connection path must be absolute");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let connection: ReturnType<typeof executionCapacityConnectionSchema.parse>;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) throw new Error("capacity connection must be private");
    connection = executionCapacityConnectionSchema.parse(JSON.parse(await handle.readFile("utf8")));
    if (connection.credential.username !== connection.providerId) throw new Error("capacity credential must identify its provider");
  } finally { await handle.close(); }
  const http = createNodeNativeGitAdmissionHttpClient();
  async function request(path: string, body: unknown) {
    const result = await http.request({ endpoint: connection.endpoint, path, method: "POST", generationId: connection.generationId,
      authorization: `Basic ${Buffer.from(`${connection.credential.username}:${connection.credential.password}`).toString("base64")}`,
      signal: AbortSignal.timeout(10_000), body: JSON.stringify(body) });
    if (result.statusCode !== 200 || result.contentType !== "application/json" || result.cacheControl !== "no-store") throw new Error("capacity authority is unavailable or stale; existing workers remain owned");
    return JSON.parse(result.body.toString("utf8")) as unknown;
  }
  return {
    endpoint: connection.endpoint, generationId: connection.generationId, providerId: connection.providerId,
    async reconcile(input: unknown) {
      const plan = executionCapacityPlanSchema.parse(await request("/v1/capacity/reconcile", executionCapacityRequestSchema.parse(input)));
      if (plan.generationId !== connection.generationId || plan.providerId !== connection.providerId) throw new Error("capacity plan identity conflicts");
      return plan;
    },
    async authorizeStop(workerId: string, revision: number) {
      const value = await request("/v1/capacity/stop", { workerId, revision });
      if (!value || typeof value !== "object" || Reflect.get(value, "allowed") !== true) throw new Error("capacity stop was not authorized");
    }
  };
}
