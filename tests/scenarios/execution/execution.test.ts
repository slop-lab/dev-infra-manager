import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ExecutionStore } from "../../../packages/control-plane/plugins/execution-scheduler/src/store.js";
import { runExecutionWorker } from "../../../packages/host/plugins/execution-worker/src/worker.js";
import type { ExecutionWorkerClient } from "../../../packages/host/plugins/execution-worker/src/client.js";
import type { ExecutionBackend } from "../../../packages/host/plugins/execution-worker/src/backend.js";
import { ProcessRunner } from "../../../packages/host/core/src/runner.js";
import { generation, event, grant, result, slot, assignment } from "../../contracts/ci/executionFixture.js";
import { runAdmission } from "../../../packages/control-plane/plugins/execution-scheduler/src/admission.js";
import { setTimeout as delay } from "node:timers/promises";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "dim-execution-")); roots.push(path); return path; }
it("deduplicates immutable events and rejects conflicting reuse", async () => {
  const store = new ExecutionStore(join(await root(), "executions.sqlite3"), generation, 1_000);
  try { const first = store.enqueue(event()); expect(store.enqueue(event()).id).toBe(first.id);
    expect(() => store.enqueue({ ...event("other"), eventId: event().eventId })).toThrow("event identity conflicts");
  } finally { store.close(); }
});
it("shares slots across instances and fences expired execution until owned cleanup", async () => {
  let now = 0; const path = join(await root(), "executions.sqlite3");
  const first = new ExecutionStore(path, generation, 100, () => now), second = new ExecutionStore(path, generation, 100, () => now);
  try {
    first.enqueue(event()); first.enqueue(event("next")); const claim = first.reserve("worker-a", slot, randomUUID())!;
    expect(() => second.reserve("worker-a", slot, randomUUID())).toThrow("slot needs"); now = 101;
    expect(() => second.renew(claim.id, "worker-a", slot.id, claim.leaseToken)).toThrow("no longer current");
    expect(() => second.reserve("worker-a", slot, randomUUID())).toThrow("slot needs");
    expect(() => second.recover(claim.id, "foreign", slot.id, claim.leaseToken)).toThrow("owned by another");
    second.recover(claim.id, "worker-a", slot.id, claim.leaseToken);
    expect(first.reserve("worker-a", slot, randomUUID())?.event.jobName).toBe("next");
  } finally { first.close(); second.close(); }
});
it("rejects a late grant after admission lease expiry", async () => {
  let now = 0; const store = new ExecutionStore(join(await root(), "executions.sqlite3"), generation, 100, () => now);
  try {
    store.enqueue(event()); const claim = store.reserve("worker-a", slot, randomUUID())!; now = 101;
    expect(() => store.attachGrant(claim.id, grant(claim))).toThrow("authorization conflicts");
    expect(store.get(claim.id).phase).toBe("recovering");
  } finally { store.close(); }
});
it("requeues transient authorization failure with bounded diagnostics", async () => {
  const store = new ExecutionStore(join(await root(), "executions.sqlite3"), generation, 1_000);
  try {
    store.enqueue(event()); const claim = store.reserve("worker-a", slot, randomUUID())!;
    const released = store.releaseAdmission(claim.id, { phase: "authorize", code: "timeout" });
    expect(released.phase).toBe("queued");
    expect(store.executionSummary(released)).toMatchObject({ admission: { phase: "authorize", code: "timeout" } });
    expect(released).not.toHaveProperty("workerId");
    expect(store.reserve("worker-b", slot, randomUUID())?.id).toBe(claim.id);
  } finally { store.close(); }
});
it("renews a pre-grant reservation only while delayed admission is connected", async () => {
  const store = new ExecutionStore(join(await root(), "executions.sqlite3"), generation, 30);
  try {
    store.enqueue(event()); const claim = store.reserve("worker-a", slot, randomUUID())!;
    const authorized = await runAdmission({ store, assignment: claim, granted: false, signal: new AbortController().signal,
      async operation(signal) { await delay(80, undefined, { signal }); return grant(claim); } });
    expect(store.attachGrant(claim.id, authorized).grant).toEqual(authorized);
  } finally { store.close(); }
});
it("keeps authorize and candidate ownership current through a 34 second fake-clock authority delay", async () => {
  let now = 0; const store = new ExecutionStore(join(await root(), "executions.sqlite3"), generation, 30_000, () => now);
  try {
    store.enqueue(event()); const claim = store.reserve("worker-a", slot, randomUUID())!;
    async function delayed<T>(value: T, granted: boolean): Promise<T> {
      let complete!: (selected: T) => void, renewals = 0; const target = now + 34_000;
      const operation = new Promise<T>((resolve) => { complete = resolve; });
      return runAdmission({ store, assignment: claim, granted, signal: new AbortController().signal,
        operation: () => operation, async wait(milliseconds) {
          now += milliseconds; renewals++;
          if (renewals === 3) { now = target; complete(value); }
        } });
    }
    const authorized = await delayed(grant(claim), false);
    const assigned = store.attachGrant(claim.id, authorized);
    const credential = await delayed({ username: "candidate", password: "a".repeat(43), expiresAt: 60_000 }, true);
    expect(credential.username).toBe("candidate"); expect(now).toBeGreaterThanOrEqual(34_000);
    expect(store.get(assigned.id)).toMatchObject({ phase: "running", leaseExpiresAt: expect.any(Number) });
  } finally { store.close(); }
});
it("aborts delayed admission without attaching a grant or fabricating a result", async () => {
  const store = new ExecutionStore(join(await root(), "executions.sqlite3"), generation, 1_000);
  try {
    store.enqueue(event()); const claim = store.reserve("worker-a", slot, randomUUID())!, disconnected = new AbortController();
    const pending = runAdmission({ store, assignment: claim, granted: false, signal: disconnected.signal,
      async operation(signal) { await delay(1_000, undefined, { signal }); return grant(claim); } });
    disconnected.abort(); await expect(pending).rejects.toThrow();
    const retained = store.get(claim.id);
    expect(retained.phase).toBe("assigned"); expect(retained).not.toHaveProperty("grant"); expect(retained).not.toHaveProperty("result");
  } finally { store.close(); }
});
it("replays claims/results and releases capacity before evidence publication", async () => {
  const store = new ExecutionStore(join(await root(), "executions.sqlite3"), generation, 1_000);
  try {
    store.enqueue(event()); store.enqueue(event("next")); const request = randomUUID();
    const claim = store.reserve("worker-a", slot, request)!, authorized = store.attachGrant(claim.id, grant(claim));
    expect(store.reserve("worker-a", slot, request)).toEqual(authorized);
    const evidence = result(authorized.grant!);
    store.finish(claim.id, "worker-a", slot.id, claim.leaseToken, evidence);
    expect(store.finish(claim.id, "worker-a", slot.id, claim.leaseToken, evidence).result).toEqual(evidence);
    expect(store.pendingResults()).toHaveLength(1);
    expect(store.reserve("worker-a", slot, randomUUID())?.event.jobName).toBe("next");
    expect(() => store.finish(claim.id, "worker-a", slot.id, claim.leaseToken,
      { ...evidence, finishedAt: new Date(Date.parse(evidence.finishedAt) + 1_000).toISOString() })).toThrow("result conflicts");
  } finally { store.close(); }
});
it("fences active leases and activation on a generation change", async () => {
  const path = join(await root(), "executions.sqlite3"), old = new ExecutionStore(path, generation, 1_000);
  old.enqueue(event()); old.enqueue(event("next")); const claim = old.reserve("worker-a", slot, randomUUID())!;
  old.activate("token"); old.close(); const current = new ExecutionStore(path, "b".repeat(64), 1_000);
  try { expect(current.activated("token")).toBe(false); expect(current.get(claim.id).phase).toBe("recovering");
    expect(() => current.renew(claim.id, "worker-a", slot.id, claim.leaseToken)).toThrow();
    current.recover(claim.id, "worker-a", slot.id, claim.leaseToken);
    const fresh = current.enqueue(event("next"));
    expect(current.enqueue(event("next")).id).toBe(fresh.id);
    const next = current.reserve("worker-a", slot, randomUUID())!;
    expect(next.event.jobName).toBe("next"); expect(next.generationId).toBe("b".repeat(64));
  } finally { current.close(); }
});
it("rejects late results after owned recovery closed an execution", async () => {
  const store = new ExecutionStore(join(await root(), "executions.sqlite3"), generation, 1_000);
  try { store.enqueue(event()); const claim = store.reserve("worker-a", slot, randomUUID())!;
    const authorized = store.attachGrant(claim.id, grant(claim)); store.recover(claim.id, "worker-a", slot.id, claim.leaseToken);
    expect(() => store.finish(claim.id, "worker-a", slot.id, claim.leaseToken, result(authorized.grant!))).toThrow("already closed");
    expect(store.pendingResults()).toEqual([]);
  } finally { store.close(); }
});
it("replays a durable result after restart without launching candidate code twice", async () => {
  const directory = await root(), stop = new AbortController(), selected = assignment();
  const authorized = { ...selected, grant: grant(selected) }; let launches = 0, reports = 0;
  const backend: ExecutionBackend = { kind: "ordinary-sysbox", async run() { launches++; return result(authorized.grant); }, async cleanup() { return true; } };
  const client: ExecutionWorkerClient = {
    async claim(requestId) { return { ...authorized, requestId }; }, async renew() { return 60_000; },
    async candidate() { return { username: "candidate", password: "a".repeat(43), expiresAt: Date.now() + 30_000 }; },
    async exchange() { throw new Error("CI execution does not exchange task messages"); },
    async recover() { throw new Error("completed work must be reported"); },
    async report() { reports++; if (reports === 1) throw new Error("lost result response"); stop.abort(); }
  };
  const options = { directory, client, backend, runner: new ProcessRunner(), gitEndpoint: "http://127.0.0.1:1234",
    gitExecutable: "/usr/bin/git", signal: stop.signal };
  await expect(runExecutionWorker(options)).rejects.toThrow("lost result response");
  expect(JSON.parse(await readFile(join(directory, "execution.json"), "utf8")).result.result).toBe("success");
  await runExecutionWorker(options); expect(launches).toBe(1); expect(reports).toBe(2);
  await expect(readFile(join(directory, "execution.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("uses the same execution lifecycle for Sysbox and QEMU slots", async () => {
  const store = new ExecutionStore(join(await root(), "executions.sqlite3"), generation, 1_000);
  try {
    store.enqueue(event()); store.enqueue(event("integration", "qemu"));
    const ordinary = store.reserve("worker-a", slot, randomUUID())!;
    const vm = store.reserve("worker-a", { ...slot, id: "vm", kind: "qemu" }, randomUUID())!;
    expect(ordinary.event.executionKind).toBe("ordinary-sysbox"); expect(vm.event.executionKind).toBe("qemu");
    for (const selected of [ordinary, vm]) {
      const authorized = store.attachGrant(selected.id, grant(selected));
      store.finish(selected.id, selected.workerId, selected.slotId, selected.leaseToken, result(authorized.grant!));
    }
    expect(store.pendingResults().map((job) => job.event.executionKind).sort()).toEqual(["ordinary-sysbox", "qemu"]);
  } finally { store.close(); }
});
it("rejects malformed aggregate state and mismatched indexed ownership instead of releasing capacity", async () => {
  const store = new ExecutionStore(join(await root(), "executions.sqlite3"), generation, 1_000);
  try {
    const selected = store.enqueue(event());
    store.database.prepare("UPDATE executions SET body=? WHERE id=?").run(JSON.stringify({ ...selected, phase: "unknown" }), selected.id);
    expect(() => store.list()).toThrow();
    store.database.prepare("UPDATE executions SET body=?,phase='finished' WHERE id=?").run(JSON.stringify(selected), selected.id);
    expect(() => store.list()).toThrow("indexes disagree");
  } finally { store.close(); }
});
