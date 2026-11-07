import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { configuredExecutionServer } from "../../../../packages/control-plane/plugins/execution-scheduler/src/service.js";
import { executionServiceConfigSchema } from "../../../../packages/control-plane/plugins/execution-scheduler/src/config.js";
import { executionCapacityPlanSchema, executionCapacityProviderSchema, taskEventSchema } from "@slop-lab/dim-contracts-execution";
import { event, generation, grant, result, slot } from "../../../contracts/ci/executionFixture.js";
import { ExecutionStore } from "../../../../packages/control-plane/plugins/execution-scheduler/src/store.js";
import { WorkerRegistry } from "../../../../packages/control-plane/plugins/execution-scheduler/src/worker-registry.js";
import { ExecutionCapacity } from "../../../../packages/control-plane/plugins/execution-scheduler/src/capacity.js";
import { parseExecution } from "@slop-lab/dim-contracts-ci/aggregate";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const secret = (n: number) => Buffer.alloc(32, n).toString("base64url");
const cost = { cpu: 1, memoryBytes: 536870912, pids: 128 };
const pool = (id: string, workerIds: string[], n = 6) => executionCapacityProviderSchema.parse({ id, token: secret(n),
  members: workerIds.map(workerId => ({ workerId, cost })), budget: { cpu: workerIds.length, memoryBytes: cost.memoryBytes * workerIds.length, pids: 128 * workerIds.length },
  maximumStarting: 1, idleMilliseconds: 1000, startMilliseconds: 5000, failureBackoffMilliseconds: 1000 });
const config = (providers = [pool("pool", ["one", "two"])]) => executionServiceConfigSchema.parse({ schemaVersion: 1, claimLeaseMilliseconds: 30_000,
  credentials: { operator: { username: "operator", password: secret(1) }, webhook: { username: "webhook", password: secret(2) }, query: { username: "query", password: secret(3) } },
  nativeGit: { endpoint: "http://127.0.0.1:9", grantIssuer: { username: "grants", password: secret(10) }, candidateReader: { username: "reader", password: secret(11) }, resultReporter: { username: "results", password: secret(12) } },
  workers: ["one", "two"].map((id, i) => ({ id, token: secret(4 + i), slots: [{ id: "primary", runtime: "container", profile: slot.profile }] })), capacityProviders: providers });
async function fixture(selected = config()) {
  const root = await mkdtemp(join(tmpdir(), "dim-capacity-")); roots.push(root);
  let now = 1000, service: ReturnType<typeof configuredExecutionServer>, endpoint = "";
  async function start(next = selected) {
    service = configuredExecutionServer({ config: next, stateDirectory: root, readinessToken: "ready", activationToken: "activate", expectedGenerationId: generation, now: () => now,
      source: { async authorize(assignment) { return grant(assignment); }, async candidate() { throw new Error("unused"); }, async publish() {} } });
    await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const address = service.server.address(); if (!address || typeof address === "string") throw new Error("missing listener"); endpoint = `http://127.0.0.1:${address.port}`;
    expect((await fetch(endpoint + "/v1/activation", { method: "POST", headers: { authorization: "Bearer activate", "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, generationId: generation }) })).status).toBe(200);
  }
  async function request(path: string, body?: unknown, name = "pool", token = secret(6), selectedGeneration = generation) {
    const response = await fetch(endpoint + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Basic ${Buffer.from(name + ":" + token).toString("base64")}`, "content-type": "application/json", "x-dim-generation-id": selectedGeneration }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    return { status: response.status, value: response.status === 204 ? undefined : await response.json() as unknown };
  }
  await start();
  return { get service() { return service!; }, request, advance(ms: number) { now += ms; },
    async plan(observations = ["one", "two"].map(workerId => ({ workerId, state: "stopped", clean: true })), drain = false, name = "pool", token = secret(6)) {
      const response = await request("/v1/capacity/reconcile", { schemaVersion: 1, observations, drain }, name, token); expect(response.status).toBe(200); return executionCapacityPlanSchema.parse(response.value);
    },
    async restart(next = selected) { await service!.close(); await start(next); }, async close() { await service!.close(); } };
}
const observed = (workerId: string, state = "running", clean = true) => ({ workerId, state, clean });
it("reserves bounded capacity from zero active workers, survives restart and does not cancel a pending start", async () => {
  const f = await fixture();
  try {
    expect((await f.request("/v1/jobs", { generationId: generation, event: event("first") }, "webhook", secret(2))).status).toBe(202);
    f.service.store.enqueue(event("second"));
    expect((await f.request("/v1/claims", { requestId: randomUUID(), slotId: "primary" }, "one", secret(4))).status).toBe(204);
    const first = await f.plan(); expect(first.workers.map(w => w.action)).toEqual(["start", "keep"]);
    expect((await f.plan()).workers[0]).toEqual(first.workers[0]); // stopped observation while boot is pending is not a failure.
    await f.restart(); expect((await f.plan()).workers[0]).toEqual(first.workers[0]);
    await f.request("/v1/worker", undefined, "one", secret(4));
    const next = await f.plan([observed("one"), observed("two", "stopped")]);
    expect(next.workers.map(w => w.state)).toEqual(["running", "starting"]);
    const workers = await f.request("/v1/operator/workers", undefined, "operator", secret(1));
    expect(JSON.stringify(workers.value)).not.toContain(secret(6));
  } finally { await f.close(); }
});
it("drains atomically without stopping occupied/recovering work and permits exact journal replay/results", async () => {
  const f = await fixture();
  try {
    f.service.store.enqueue(event()); await f.plan();
    const id = randomUUID(), response = await f.request("/v1/claims", { requestId: id, slotId: "primary" }, "one", secret(4));
    expect(response.status).toBe(200); const assignment = parseExecution(response.value);
    const plan = await f.plan([observed("one", "running", false), observed("two", "stopped")], true);
    expect(plan.workers[0]).toMatchObject({ state: "draining", action: "keep" });
    expect((await f.request("/v1/capacity/stop", { workerId: "one", revision: plan.workers[0]!.revision })).status).toBe(409);
    expect((await f.request("/v1/claims", { requestId: randomUUID(), slotId: "primary" }, "one", secret(4))).status).toBe(204);
    expect((await f.request("/v1/claims", { requestId: id, slotId: "primary" }, "one", secret(4))).status).toBe(200);
    expect((await f.request(`/v1/executions/${assignment.id}/result`, { slotId: "primary", leaseToken: assignment.leaseToken, result: result(assignment.grant!) }, "one", secret(4))).status).toBe(200);
    const stopped = await f.plan([observed("one"), observed("two", "stopped")], true);
    expect(stopped.workers[0]).toMatchObject({ state: "draining", action: "stop" });
    expect((await f.request("/v1/capacity/stop", { workerId: "one", revision: stopped.workers[0]!.revision - 1 })).status).toBe(409);
    expect((await f.request("/v1/capacity/stop", { workerId: "one", revision: stopped.workers[0]!.revision })).status).toBe(200);
  } finally { await f.close(); }
});
it("fences expired provider authority, removed pools and failed starts without changing worker credentials", async () => {
  const f = await fixture(config([pool("pool", ["one"])]));
  const plan = () => f.plan([observed("one", "stopped")]);
  try {
    f.service.store.enqueue(event()); await plan();
    f.advance(5001);
    expect((await f.request("/v1/claims", { requestId: randomUUID(), slotId: "primary" }, "one", secret(4))).status).toBe(204);
    const timeout = await plan(); expect(timeout.workers[0]!.state).toBe("draining");
    await plan(); // confirmed stopped, enter backoff
    expect((await plan()).workers[0]!.action).toBe("keep"); f.advance(1001);
    expect((await plan()).workers[0]!.action).toBe("start");
    await f.restart(config([]));
    expect((await f.request("/v1/claims", { requestId: randomUUID(), slotId: "primary" }, "one", secret(4))).status).toBe(204);
    expect((await f.request("/v1/worker", undefined, "one", secret(4))).status).toBe(200);
  } finally { await f.close(); }
});
it("keeps idle hysteresis and subtracts capacity already planned by another provider", async () => {
  const f = await fixture(config([pool("pool", ["one"]), pool("other", ["two"], 7)]));
  try {
    f.service.store.enqueue(event());
    expect((await f.plan([observed("one", "stopped")])).workers[0]!.action).toBe("start");
    expect((await f.plan([observed("two", "stopped")], false, "other", secret(7))).workers[0]!.action).toBe("keep");
    f.service.store.reject(f.service.store.list()[0]!.id);
    await f.request("/v1/worker", undefined, "one", secret(4));
    expect((await f.plan([observed("one")])).workers[0]!.action).toBe("keep");
    f.advance(999); expect((await f.plan([observed("one")])).workers[0]!.state).toBe("running");
    f.advance(2); expect((await f.plan([observed("one")])).workers[0]!.action).toBe("stop");
  } finally { await f.close(); }
});
it("requires scoped provider credentials/generation/member observations and distinct role identities", async () => {
  const f = await fixture();
  try {
    const body = { schemaVersion: 1, observations: [] };
    expect((await f.request("/v1/capacity/reconcile", body, "operator", secret(1))).status).toBe(401);
    expect((await f.request("/v1/capacity/reconcile", body, "pool", secret(6), "b".repeat(64))).status).toBe(409);
    expect((await f.request("/v1/capacity/reconcile", body)).status).toBe(409);
    expect((await f.request("/v1/operator/workers")).status).toBe(401);
    expect((await f.request("/v1/operator/workers/enroll", {})).status).toBe(401);
    expect((await f.request("/v1/claims", {})).status).toBe(401);
    const c = config(); expect(executionServiceConfigSchema.safeParse({ ...c, capacityProviders: [{ ...c.capacityProviders![0], token: secret(1) }] }).success).toBe(false);
    expect(executionCapacityProviderSchema.safeParse({ ...c.capacityProviders![0], budget: { ...cost, cpu: 1 } }).success).toBe(false);
    expect((await f.request("/v1/operator/workers/enroll", { schemaVersion: 1, workerId: "pool", slots: c.workers[0]!.slots }, "operator", secret(1))).status).toBe(409);
  } finally { await f.close(); }
});
it("matches generic task revisions and enforces explicit task pool reservation costs", async () => {
  const c = config(); const revision = "f".repeat(64);
  const selected = executionServiceConfigSchema.parse({ ...c, nativeGit: undefined, credentials: { operator: c.credentials.operator, tasks: { username: "tasks", password: secret(20) } },
    workers: c.workers.map(worker => ({ ...worker, slots: [{ id: "primary", taskType: "work", handlerRevision: revision }] })) });
  const f = await fixture(selected);
  try {
    f.service.store.enqueue(taskEventSchema.parse({ eventId: randomUUID(), executionKind: "task/work", taskType: "work", handlerRevision: "e".repeat(64), payload: {} }));
    expect((await f.plan()).workers.every(w => w.action === "keep")).toBe(true);
    f.service.store.enqueue(taskEventSchema.parse({ eventId: randomUUID(), executionKind: "task/work", taskType: "work", handlerRevision: revision, payload: {} }));
    expect((await f.plan()).workers[0]!.action).toBe("start");
  } finally { await f.close(); }
});

it("does not let an expired provider's unoccupied planned slots starve a live pool", async () => {
  const f = await fixture(config([pool("pool", ["one"]), pool("other", ["two"], 7)]));
  try {
    f.service.store.enqueue(event());
    await f.plan([observed("one", "stopped")]);
    expect((await f.plan([observed("two", "stopped")], false, "other", secret(7))).workers[0]!.action).toBe("keep");
    f.advance(5001);
    expect((await f.plan([observed("two", "stopped")], false, "other", secret(7))).workers[0]!.action).toBe("start");
    expect((await f.request("/v1/claims", { requestId: randomUUID(), slotId: "primary" }, "one", secret(4))).status).toBe(204);
  } finally { await f.close(); }
});
it("never stops busy or recovering workers when boot times out; new claims drain but renewal/recovery remain authorized", async () => {
  const f = await fixture(config([pool("pool", ["one"])]));
  try {
    f.service.store.enqueue(event()); await f.plan([observed("one", "stopped")]);
    const requestId = randomUUID(), reserved = f.service.store.reserve("one", slot, requestId)!;
    const assignment = f.service.store.attachGrant(reserved.id, grant(reserved));
    f.advance(5001);
    const plan = await f.plan([observed("one", "running", false)]);
    expect(plan.workers[0]).toMatchObject({ state: "draining", action: "keep" });
    const operatorWorkers = await f.request("/v1/operator/workers", undefined, "operator", secret(1));
    expect(operatorWorkers.value).toEqual(expect.arrayContaining([expect.objectContaining({ id: "one", slots: [expect.objectContaining({ available: false, state: "busy" })] })]));
    expect((await f.request("/v1/claims", { requestId: randomUUID(), slotId: "primary" }, "one", secret(4))).status).toBe(204);
    expect((await f.request(`/v1/executions/${assignment.id}/renew`, { slotId: "primary", leaseToken: assignment.leaseToken }, "one", secret(4))).status).toBe(200);
    f.service.store.cancel(assignment.id);
    expect((await f.plan([observed("one", "running", false)])).workers[0]!.action).toBe("keep");
    expect((await f.request("/v1/capacity/stop", { workerId: "one", revision: plan.workers[0]!.revision })).status).toBe(409);
    expect((await f.request(`/v1/executions/${assignment.id}/recover`, { slotId: "primary", leaseToken: assignment.leaseToken, cleanupComplete: true }, "one", secret(4))).status).toBe(200);
  } finally { await f.close(); }
});

it("backs off failed starts once without resetting their retry deadline on every failed observation", async () => {
  const f = await fixture(config([pool("pool", ["one"])]));
  try {
    f.service.store.enqueue(event()); await f.plan([observed("one", "stopped")]);
    expect((await f.plan([observed("one", "failed")])).workers[0]!.state).toBe("stopped");
    f.advance(999); expect((await f.plan([observed("one", "failed")])).workers[0]!.action).toBe("keep");
    f.advance(2); expect((await f.plan([observed("one", "failed")])).workers[0]!.action).toBe("start");
  } finally { await f.close(); }
});
it("rejects malformed Basic without a separator even when its bytes could match the provider id/token slices", async () => {
  const decoded = "a".repeat(42) + "A", id = decoded.slice(0, -1);
  const f = await fixture(config([{ ...pool(id, ["one"]), token: decoded }]));
  try {
    const address = f.service.server.address(); if (!address || typeof address === "string") throw new Error("missing listener");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/capacity/reconcile`, { method: "POST",
      headers: { authorization: `Basic ${Buffer.from(decoded).toString("base64")}`, "content-type": "application/json", "x-dim-generation-id": generation },
      body: JSON.stringify({ schemaVersion: 1, observations: [observed("one", "stopped")] }) });
    expect(response.status).toBe(401);
  } finally { await f.close(); }
});

it("rechecks drain authority inside the reserve transaction even after a second connection observed capacity enabled", async () => {
  const selected = config([pool("pool", ["one"])]), f = await fixture(selected);
  let second: ExecutionStore | undefined;
  try {
    f.service.store.enqueue(event()); await f.plan([observed("one", "stopped")]);
    const path = String(f.service.store.database.prepare("PRAGMA database_list").get()!.file);
    second = new ExecutionStore(path, generation, selected.claimLeaseMilliseconds, f.service.store.now);
    const capacity = new ExecutionCapacity(second, new WorkerRegistry(second.database, generation, selected, second.now), selected, generation);
    expect(capacity.available("one")).toBe(true);
    await f.plan([observed("one", "stopped")], true);
    const requestId = randomUUID();
    expect(second.reserve("one", slot, requestId, () => capacity.allowsClaim("one", "primary", requestId))).toBeUndefined();
    expect(f.service.store.get(f.service.store.list()[0]!.id).phase).toBe("queued");
  } finally { second?.close(); await f.close(); }
});
