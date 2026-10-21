import { z } from "zod";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import type { NativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import { parseExecution, type ExecutionAssignment, type ExecutionResult } from "@slop-lab/dim-contracts-ci/aggregate";
import { taskJobSchema, type TaskAssignment, type TaskResult } from "@slop-lab/dim-task-scheduling";

export type WorkerAssignment = ExecutionAssignment | TaskAssignment;
export type WorkerResult = ExecutionResult | TaskResult;
export function isTaskAssignment(assignment: WorkerAssignment): assignment is TaskAssignment { return assignment.event.executionKind.startsWith("task/"); }

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
  const ownership = (assignment: WorkerAssignment) => ({ slotId: config.slotId, leaseToken: assignment.leaseToken });
  const path = (assignment: WorkerAssignment, action: string) => `/v1/executions/${assignment.id}/${action}`;
  return {
    async claim(requestId: string, signal?: AbortSignal): Promise<WorkerAssignment | undefined> {
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
      return assignment;
    },
    async renew(assignment: WorkerAssignment, signal?: AbortSignal): Promise<number> {
      const result = z.object({ expiresAt: z.number().int(), leaseMilliseconds: z.number().int().positive() }).strict()
        .parse(await request(path(assignment, "renew"), ownership(assignment), signal));
      return result.leaseMilliseconds;
    },
    async candidate(assignment: WorkerAssignment, signal?: AbortSignal) {
      if (isTaskAssignment(assignment)) throw new Error("generic tasks cannot acquire candidate credentials");
      return z.object({ username: z.string().min(1), password: z.string().min(1), expiresAt: z.number().int() }).strict()
        .parse(await request(path(assignment, "candidate"), ownership(assignment), signal));
    },
    async exchange(assignment: TaskAssignment, operation: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
      const result = z.object({ value: z.unknown() }).strict().parse(await request(path(assignment, "exchange"), { ...ownership(assignment), operation, input }, signal));
      return result.value;
    },
    async report(assignment: WorkerAssignment, result: WorkerResult, signal?: AbortSignal): Promise<void> {
      await request(path(assignment, "result"), { ...ownership(assignment), result }, signal);
    },
    async recover(assignment: WorkerAssignment, signal?: AbortSignal): Promise<void> {
      await request(path(assignment, "recover"), { ...ownership(assignment), cleanupComplete: true }, signal);
    }
  };
}
export type ExecutionWorkerClient = ReturnType<typeof executionWorkerClient>;
export function parseAssignment(value: unknown): WorkerAssignment {
  const task = value !== null && typeof value === "object" && "event" in value && value.event !== null && typeof value.event === "object" && "executionKind" in value.event && typeof value.event.executionKind === "string" && value.event.executionKind.startsWith("task/");
  const job = task ? taskJobSchema.parse(value) : parseExecution(value);
  if (job.phase === "queued") throw new Error("CI assignment is queued");
  return job as WorkerAssignment;
}
