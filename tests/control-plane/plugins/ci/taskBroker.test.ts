import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { configuredExecutionServer } from "../../../../packages/control-plane/plugins/ci/src/service.js";
import { executionServiceConfigSchema } from "../../../../packages/contracts/ci/src/config.js";
import { runScheduledTask, taskJobSchema, type TaskAssignment } from "../../../../packages/task-scheduling/src/index.js";

const generationId = "a".repeat(64), revision = "b".repeat(64);
const secret = (value: number) => Buffer.alloc(32, value).toString("base64url");
const issuer = { username: "tasks", password: secret(4) }, worker = { username: "worker", password: secret(5) };
const config = executionServiceConfigSchema.parse({ schemaVersion: 1, claimLeaseMilliseconds: 1000,
  credentials: { webhook: { username: "webhook", password: secret(1) }, query: { username: "query", password: secret(2) }, operator: { username: "operator", password: secret(3) }, tasks: issuer },
  workers: [{ id: worker.username, token: worker.password, slots: [{ id: "shared", taskType: "review-tracing", handlerRevision: revision }] }] });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dim-task-broker-"));
  let now = 1000, endpoint = "";
  let service = configuredExecutionServer({ config, stateDirectory: directory, readinessToken: "ready", activationToken: "activate", expectedGenerationId: generationId, now: () => now });
  async function start() {
    await new Promise<void>((resolve, reject) => { service.server.once("error", reject); service.server.listen(0, "127.0.0.1", resolve); });
    const address = service.server.address(); if (address === null || typeof address === "string") throw new Error("missing scheduler address");
    endpoint = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${endpoint}/v1/activation`, { method: "POST", headers: { authorization: "Bearer activate", "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, generationId }), signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(200); await response.arrayBuffer();
  }
  async function request(path: string, body?: object, credential = issuer) {
    const response = await fetch(`${endpoint}${path}`, { method: body === undefined ? "GET" : "POST", headers: {
      authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`, "content-type": "application/json", "x-dim-generation-id": generationId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const value: unknown = response.status === 204 ? undefined : await response.json();
    return { status: response.status, value };
  }
  await start();
  return {
    get endpoint() { return endpoint; }, get service() { return service; }, request,
    advance(milliseconds: number) { now += milliseconds; },
    async submit() {
      const response = await request("/v1/tasks", { requestId: randomUUID(), taskType: "review-tracing", handlerRevision: revision, payload: {} });
      expect(response.status).toBe(200); return String(Reflect.get(response.value as object, "executionId"));
    },
    async claim() {
      const response = await request("/v1/claims", { requestId: randomUUID(), slotId: "shared" }, worker);
      expect(response.status).toBe(200); const job = taskJobSchema.parse(response.value);
      expect(job.grant).toBeDefined(); return job as TaskAssignment;
    },
    async report(job: TaskAssignment) {
      return request(`/v1/executions/${job.id}/result`, { slotId: job.slotId, leaseToken: job.leaseToken,
        result: { executionId: job.id, descriptorDigest: job.grant!.descriptorDigest, cleanupComplete: true, result: "success", value: false } }, worker);
    },
    async restart() {
      await service.close(); service = configuredExecutionServer({ config, stateDirectory: directory, readinessToken: "ready", activationToken: "activate", expectedGenerationId: generationId, now: () => now }); await start();
    },
    async close() { try { await service.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
  };
}

it("keeps an accepted result idempotent after producer acknowledgement and worker report replay", async () => {
  const f = await fixture();
  try {
    const id = await f.submit(), job = await f.claim();
    expect((await f.report(job)).status).toBe(200);
    const accepted = await f.request(`/v1/tasks/${id}/exchange`);
    expect(accepted.status).toBe(200); expect(accepted.value).toMatchObject({ result: { result: "success", value: false } });
    expect((await f.request(`/v1/tasks/${id}/complete`, {})).status).toBe(200);
    expect((await f.report(job)).status).toBe(200);
    expect(f.service.store.get(id).publication).toBe("accepted");
  } finally { await f.close(); }
});

it("rejects successful results from a previous ephemeral broker session after restart", async () => {
  const f = await fixture();
  try {
    const id = await f.submit(), job = await f.claim(); await f.restart();
    expect((await f.report(job)).status).toBe(200);
    expect(f.service.store.get(id).publication).toBe("stale");
    expect((await f.request(`/v1/tasks/${id}/exchange`)).status).toBe(409);
  } finally { await f.close(); }
});

it("denies expired lease exchanges and never accepts their later results", async () => {
  const f = await fixture();
  try {
    const id = await f.submit(), job = await f.claim(); f.advance(1001);
    expect((await f.request(`/v1/executions/${id}/exchange`, { slotId: job.slotId, leaseToken: job.leaseToken, operation: "read", input: {} }, worker)).status).toBe(409);
    expect((await f.report(job)).status).toBe(200);
    expect(f.service.store.get(id).publication).toBe("stale");
    expect((await f.request(`/v1/tasks/${id}/exchange`)).value).not.toHaveProperty("result");
  } finally { await f.close(); }
});

it("rejects early completion without discarding its active session", async () => {
  const f = await fixture();
  try {
    const id = await f.submit(); await f.claim();
    expect((await f.request(`/v1/tasks/${id}/complete`, {})).status).toBe(409);
    expect((await f.request(`/v1/tasks/${id}/exchange`)).status).toBe(200);
    expect(f.service.store.get(id).phase).toBe("assigned");
  } finally { await f.close(); }
});

it("aborts a hung producer callback and cancels the durable job independently", async () => {
  const f = await fixture(), stop = new AbortController(); let entered = false;
  const execution = runScheduledTask({ endpoint: f.endpoint, generationId, credential: issuer, taskType: "review-tracing", handlerRevision: revision, payload: {}, signal: stop.signal,
    exchange() { entered = true; return new Promise(() => {}); } });
  const rejected = expect(execution).rejects.toThrow(/abort/i);
  try {
    const deadline = Date.now() + 2000;
    while (f.service.store.list().length === 0) { if (Date.now() > deadline) throw new Error("submission did not reach scheduler"); await delay(5); }
    const job = await f.claim();
    const exchange = f.request(`/v1/executions/${job.id}/exchange`, { slotId: job.slotId, leaseToken: job.leaseToken, operation: "read", input: {} }, worker);
    while (!entered) { if (Date.now() > deadline) throw new Error("producer did not receive exchange"); await delay(5); }
    stop.abort();
    await Promise.race([rejected, delay(2000).then(() => { throw new Error("hung exchange ignored abort"); })]);
    expect((await exchange).status).toBe(409);
    expect(f.service.store.get(job.id)).toMatchObject({ phase: "recovering", cancelRequestedAt: 1000 });
  } finally { stop.abort(); await f.close(); }
});

it("acknowledges a failed task and releases its broker session before accepting more work", async () => {
  const f = await fixture();
  const execution = runScheduledTask({ endpoint: f.endpoint, generationId, credential: issuer, taskType: "review-tracing", handlerRevision: revision,
    payload: {}, async exchange() { throw new Error("unexpected exchange"); } });
  const rejected = expect(execution).rejects.toThrow(/failed|cancelled/i);
  try {
    const deadline = Date.now() + 2000;
    while (f.service.store.list().length === 0) { if (Date.now() > deadline) throw new Error("submission did not reach scheduler"); await delay(5); }
    const job = await f.claim();
    const response = await f.request(`/v1/executions/${job.id}/result`, { slotId: job.slotId, leaseToken: job.leaseToken,
      result: { executionId: job.id, descriptorDigest: job.grant!.descriptorDigest, cleanupComplete: true, result: "failure", error: "detector syntax error" } }, worker);
    expect(response.status).toBe(200);
    await rejected;
    expect((await f.request(`/v1/tasks/${job.id}/exchange`)).status).toBe(409);
    expect(await f.submit()).not.toBe(job.id);
  } finally { await f.close(); }
});
