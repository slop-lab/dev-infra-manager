import { executionGrantSchema } from "@slop-lab/dim-contracts-ci/execution";
import { z } from "zod";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-ci/http";
import type { NativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-ci/http";
import { parseExecution, type ExecutionAssignment, type ExecutionResult } from "@slop-lab/dim-contracts-ci/aggregate";

export class ExecutionLeaseLostError extends Error {}
export class ExecutionServiceUnavailableError extends Error {}
export function executionWorkerClient(config: { readonly endpoint: string; readonly workerId: string;
  readonly token: string; readonly slotId: string; readonly generationId: string },
  http: NativeGitAdmissionHttpClient = createNodeNativeGitAdmissionHttpClient()) {
  async function request(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    let response;
    try { response = await http.request({ endpoint: config.endpoint, path, method: "POST",
      authorization: `Basic ${Buffer.from(`${config.workerId}:${config.token}`).toString("base64")}`,
      generationId: config.generationId, body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal === undefined ? [] : [signal])]) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ExecutionServiceUnavailableError("CI connection is unavailable", { cause: error });
    }
    if (response.statusCode >= 500) throw new ExecutionServiceUnavailableError("CI service is unavailable");
    if (response.statusCode === 409 || response.statusCode === 404) throw new ExecutionLeaseLostError();
    if (response.statusCode === 204) return undefined;
    if (response.statusCode !== 200 || response.contentType !== "application/json" || response.cacheControl !== "no-store") {
      throw new Error("CI worker request failed");
    }
    return JSON.parse(response.body.toString("utf8"));
  }
  const ownership = (assignment: ExecutionAssignment) => ({ slotId: config.slotId, leaseToken: assignment.leaseToken });
  const path = (assignment: ExecutionAssignment, action: string) => `/v1/executions/${assignment.id}/${action}`;
  return {
    async claim(requestId: string, signal?: AbortSignal): Promise<ExecutionAssignment | undefined> {
      const value = await request("/v1/claims", { requestId, slotId: config.slotId }, signal);
      if (value === undefined) return undefined;
      // Persisted ownership is validated before it can identify resources on this host.
      const assignment = parseAssignment(value);
      if (assignment.workerId !== config.workerId || assignment.slotId !== config.slotId || assignment.requestId !== requestId) {
        throw new Error("CI assignment ownership mismatch");
      }
      if (assignment.phase !== "recovering" && assignment.phase !== "finished" && assignment.generationId !== config.generationId) {
        throw new ExecutionLeaseLostError();
      }
      return assignment as ExecutionAssignment;
    },
    async renew(assignment: ExecutionAssignment, signal?: AbortSignal): Promise<number> {
      const result = z.object({ expiresAt: z.number().int(), leaseMilliseconds: z.number().int().positive() }).strict()
        .parse(await request(path(assignment, "renew"), ownership(assignment), signal));
      return result.leaseMilliseconds;
    },
    async candidate(assignment: ExecutionAssignment, signal?: AbortSignal) {
      return z.object({ username: z.string().min(1), password: z.string().min(1), expiresAt: z.number().int() }).strict()
        .parse(await request(path(assignment, "candidate"), ownership(assignment), signal));
    },
    async report(assignment: ExecutionAssignment, result: ExecutionResult, signal?: AbortSignal): Promise<void> {
      await request(path(assignment, "result"), { ...ownership(assignment), result }, signal);
    },
    async recover(assignment: ExecutionAssignment, signal?: AbortSignal): Promise<void> {
      await request(path(assignment, "recover"), { ...ownership(assignment), cleanupComplete: true }, signal);
    }
  };
}
export type ExecutionWorkerClient = ReturnType<typeof executionWorkerClient>;
export function parseAssignment(value: unknown): ExecutionAssignment {
  const job = parseExecution(value);
  if (job.phase === "queued") throw new Error("CI assignment is queued");
  return job as ExecutionAssignment;
}
