import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionServiceConfigSchema } from "../../packages/control-plane/plugins/execution-scheduler/src/config.js";
import { configuredExecutionServer } from "../../packages/control-plane/plugins/execution-scheduler/src/service.js";
import { executionWorkerClient } from "../../packages/host/plugins/execution-worker/src/client.js";
import { runExecutionWorker } from "../../packages/host/plugins/execution-worker/src/worker.js";
import type { ExecutionTaskHandler } from "@slop-lab/dim-contracts-execution/plugin-api";
import { createScheduledReviewTraceRuntime } from "../../packages/control-plane/plugins/git-review-tracing-scheduled/src/index.js";

export const generationId = "a".repeat(64);
export const secret = (value: number) => Buffer.alloc(32, value).toString("base64url");
export const credential = { username: "review-tasks", password: secret(4) };
const workerToken = secret(5);

/** A task-only deployment: no Native Git credentials or CI checkout authority. */
export async function schedulerFixture(handlerRevision: string) {
  const directory = await mkdtemp(join(tmpdir(), "dim-scheduled-review-"));
  let service: ReturnType<typeof configuredExecutionServer> | undefined;
  try {
    const config = executionServiceConfigSchema.parse({ schemaVersion: 1, claimLeaseMilliseconds: 1_000,
      credentials: { webhook: { username: "webhook", password: secret(1) },
        query: { username: "query", password: secret(2) },
        operator: { username: "operator", password: secret(3) }, tasks: credential },
      workers: [{ id: "review-host", token: workerToken, slots: [{ id: "review", taskType: "review-tracing", handlerRevision }] }] });
    service = configuredExecutionServer({ config, stateDirectory: join(directory, "service"),
      readinessToken: "ready", activationToken: "activate", expectedGenerationId: generationId });
    await new Promise<void>((resolve, reject) => {
      service!.server.once("error", reject);
      service!.server.listen(0, "127.0.0.1", resolve);
    });
    const address = service.server.address();
    assert(address !== null && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${endpoint}/v1/activation`, { method: "POST", signal: AbortSignal.timeout(5_000),
      headers: { authorization: "Bearer activate", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, generationId }) });
    assert.equal(response.status, 200);
    const running = service;
    return { endpoint, directory, service: running, async close() {
      try { await running.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    } };
  } catch (error) {
    try { await service?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
}

export async function startWorker(fixture: Awaited<ReturnType<typeof schedulerFixture>>, handler: ExecutionTaskHandler) {
  const stop = new AbortController();
  const work = runExecutionWorker({ directory: join(fixture.directory, "worker"),
    client: executionWorkerClient({ endpoint: fixture.endpoint, workerId: "review-host", slotId: "review", token: workerToken, generationId }),
    taskHandlers: [handler], signal: stop.signal });
  // Attach a handler immediately so an early worker failure is never unhandled.
  const settled = work.then(() => undefined, (error: unknown) => error);
  return { async close() {
    stop.abort();
    const error = await settled;
    if (error !== undefined && !(error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message)))) throw error;
  } };
}


/** Real scheduler + installed host handler; one shared worker lifecycle. */
export async function scheduledReviewFixture() {
  const { reviewTracingTaskHandler } = await import("../../packages/host/plugins/git-review-tracing-node/src/index.js");
  const scheduler = await schedulerFixture(reviewTracingTaskHandler.revision);
  try {
    const worker = await startWorker(scheduler, reviewTracingTaskHandler);
    return {
      runtime: createScheduledReviewTraceRuntime({ endpoint: scheduler.endpoint, generationId, credential,
        handlerRevision: reviewTracingTaskHandler.revision }),
      async close() { try { await worker.close(); } finally { await scheduler.close(); } }
    };
  } catch (error) { await scheduler.close(); throw error; }
}
