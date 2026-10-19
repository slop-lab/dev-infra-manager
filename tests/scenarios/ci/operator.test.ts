import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configuredExecutionServer } from "../../../packages/control-plane/plugins/ci/src/service.js";
import { executionServiceConfigSchema } from "../../../packages/contracts/ci/src/config.js";
import { createCiOperatorClient } from "../../../packages/control-plane/admin/src/ci/operator.js";
import { idleOrdinaryConfig } from "../../control-plane/plugins/native-git/bundleConfigFixture.js";
import { event, grant, result, generation } from "../../contracts/ci/executionFixture.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-ci-operator-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = executionServiceConfigSchema.parse(idleOrdinaryConfig());
  const published: string[] = [];
  const ci = configuredExecutionServer({ config, stateDirectory: join(root, "state"), readinessToken: "ready", activationToken: "activate",
    expectedGenerationId: generation, source: { authorize: async (job) => grant(job), candidate: async () => { throw new Error("unused"); }, publish: async (job) => { published.push(job.executionId); } } });
  cleanups.push(() => ci.close());
  await new Promise<void>((resolve) => ci.server.listen(0, "127.0.0.1", resolve));
  const address = ci.server.address(); if (!address || typeof address === "string") throw new Error("listener unavailable");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const request = (path: string, credential: { username: string; password: string }, body?: unknown, selectedGeneration = generation) => fetch(endpoint + path, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
      "x-dim-generation-id": selectedGeneration, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect((await fetch(endpoint + "/v1/activation", { method: "POST", headers: { authorization: "Bearer activate", "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, generationId: generation }) })).status).toBe(200);
  const connection = join(root, "operator.json"); await writeFile(connection, JSON.stringify({ schemaVersion: 1, role: "operator", endpoint, generationId: generation, credential: config.credentials.operator }), { mode: 0o600 });
  const operator = await createCiOperatorClient(connection);
  const worker = config.workers[0]!;
  const credential = { username: worker.id, password: worker.token };
  return { ci, config, request, operator, credential, worker, published };
}
it("isolates operator authority and generation, cancels queued work, and retries idempotently without duplicating intake", async () => {
  const f = await fixture(), original = f.ci.store.enqueue(event());
  expect((await f.request("/v1/operator/workers", f.config.credentials.query)).status).toBe(401);
  expect((await f.request("/v1/operator/workers", f.credential)).status).toBe(401);
  expect((await f.request("/v1/operator/workers", f.config.credentials.operator, undefined, "b".repeat(64))).status).toBe(409);
  expect((await f.request("/v1/jobs", f.config.credentials.operator)).status).toBe(401);
  expect(await f.operator.cancel(original.id)).toMatchObject({ phase: "finished", publication: "stale", cancelRequestedAt: expect.any(Number) });
  const requestId = randomUUID();
  const retries = await Promise.all([f.operator.retry(original.id, requestId), f.operator.retry(original.id, requestId)]);
  expect(retries[0]?.id).toBe(retries[1]?.id);
  expect(retries[0]).toMatchObject({ phase: "queued", retryOf: original.id });
  await expect(f.operator.retry(original.id, randomUUID())).rejects.toThrow(/conflicts/);
  expect(f.ci.store.enqueue(event()).id).toBe(original.id);
  expect(f.ci.store.list()).toHaveLength(2);
  expect(f.ci.store.recentSummaries()[0]?.retryOf).toBe(original.id);
});
it("fences cancellation until owned cleanup and suppresses a racing success from publication", async () => {
  const f = await fixture(); f.ci.store.enqueue(event());
  const slotId = f.worker.slots[0]!.id;
  const claim = await f.request("/v1/claims", f.credential, { requestId: randomUUID(), slotId });
  expect(claim.status).toBe(200);
  const assigned = f.ci.store.list()[0]!; if (!assigned.grant || !assigned.leaseToken) throw new Error("missing grant");
  const ownership = { slotId, leaseToken: assigned.leaseToken };
  expect((await f.request(`/v1/executions/${assigned.id}/renew`, f.credential, ownership)).status).toBe(200);
  expect(await f.operator.cancel(assigned.id)).toMatchObject({ phase: "recovering" });
  expect((await f.operator.workers())[0]?.slots[0]?.state).toBe("cleanup-required");
  expect((await f.request(`/v1/executions/${assigned.id}/renew`, f.credential, ownership)).status).toBe(409);
  expect((await f.request("/v1/claims", f.credential, { requestId: randomUUID(), slotId })).status).toBe(409);
  await expect(f.operator.retry(assigned.id, randomUUID())).rejects.toThrow(/conflicts/);
  const evidence = result(assigned.grant);
  expect((await f.request(`/v1/executions/${assigned.id}/result`, f.credential, { ...ownership, result: evidence })).status).toBe(200);
  expect(f.ci.store.get(assigned.id)).toMatchObject({ phase: "finished", publication: "stale", result: { result: "success" } });
  expect((await f.operator.workers())[0]?.slots[0]?.state).toBe("idle");
  expect(f.published).toEqual([]);
  const retried = await f.operator.retry(assigned.id, randomUUID());
  expect(retried.retryOf).toBe(assigned.id);
  expect((await f.request("/v1/claims", f.credential, { requestId: randomUUID(), slotId })).status).toBe(200);
});
