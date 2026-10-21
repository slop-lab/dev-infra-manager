import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ExecutionStore } from "../../../../packages/control-plane/plugins/execution-scheduler/src/store.js";
import { taskDescriptorDigest, taskEventSchema, taskGrantSchema, taskJobSchema, type TaskAssignment, type TaskGrant, type TaskProfile } from "@slop-lab/dim-contracts-execution";
import { generation, event, slot } from "../../../contracts/ci/executionFixture.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function path() { const directory = await mkdtemp(join(tmpdir(), "dim-task-scheduler-")); directories.push(directory); return join(directory, "executions.sqlite3"); }
const revision = "c".repeat(64);
const profile: TaskProfile = { taskType: "review-trace", handlerRevision: revision };
const taskSlot = { id: slot.id, kind: "task/review-trace", profile };
function task(handlerRevision = revision) { return taskEventSchema.parse({ eventId: randomUUID(), executionKind: "task/review-trace", taskType: "review-trace", handlerRevision, payload: { sessionId: "immutable-review-session" } }); }
function grant(job: TaskAssignment): TaskGrant { return taskGrantSchema.parse({ executionId: job.id, generationId: job.generationId, workerId: job.workerId, slotId: job.slotId, event: job.event, profile: job.profile, descriptorDigest: taskDescriptorDigest(job.event, job.profile) }); }

it("shares occupied capacity between CI and generic tasks and fences expired owners until cleanup", async () => {
  let now = 0; const database = await path();
  const first = new ExecutionStore(database, generation, 100, () => now), second = new ExecutionStore(database, generation, 100, () => now);
  try {
    first.enqueue(event()); first.enqueue(task());
    const ci = first.reserve("worker-a", slot, randomUUID())!;
    expect(() => second.reserve("worker-a", taskSlot, randomUUID())).toThrow("slot needs");
    first.recover(ci.id, ci.workerId, ci.slotId, ci.leaseToken);
    const assigned = second.reserve("worker-a", taskSlot, randomUUID())!;
    const authorized = second.attachGrant(assigned.id, grant(assigned));
    now = 101;
    expect(() => first.renew(assigned.id, assigned.workerId, assigned.slotId, assigned.leaseToken)).toThrow("no longer current");
    expect(() => first.reserve("worker-a", slot, randomUUID())).toThrow("slot needs");
    second.recover(assigned.id, assigned.workerId, assigned.slotId, assigned.leaseToken);
    expect(() => first.finish(assigned.id, assigned.workerId, assigned.slotId, assigned.leaseToken, { executionId: assigned.id, descriptorDigest: authorized.grant!.descriptorDigest, cleanupComplete: true, result: "success", value: false })).toThrow("already closed");
    expect(first.recentSummaries()).toHaveLength(1);
  } finally { first.close(); second.close(); }
});

it("selects the exact handler revision and validates task input, grant and aggregate tuples", async () => {
  const store = new ExecutionStore(await path(), generation, 1000);
  try {
    store.enqueue(task("d".repeat(64))); const expected = store.enqueue(task());
    const selected = store.reserve("worker-a", taskSlot, randomUUID())!;
    expect(selected.id).toBe(expected.id);
    expect(() => taskGrantSchema.parse({ ...grant(selected), descriptorDigest: `sha256:${"0".repeat(64)}` })).toThrow();
    const authorized = store.attachGrant(selected.id, grant(selected));
    expect(() => taskJobSchema.parse({ ...authorized, slotId: "different" })).toThrow("inconsistent");
    expect(() => taskEventSchema.parse({ ...task(), executionKind: "task/other" })).toThrow("differs");
    expect(taskDescriptorDigest(selected.event, selected.profile)).toBe(taskDescriptorDigest({ ...selected.event, payload: { sessionId: "immutable-review-session" } }, selected.profile));
    expect(store.recentSummaries()).toEqual([]);
  } finally { store.close(); }
});

it("retains generic recovery fencing across scheduler generations and rejects stale renewal", async () => {
  const database = await path(); const old = new ExecutionStore(database, generation, 1000);
  old.enqueue(task()); const assigned = old.reserve("worker-a", taskSlot, randomUUID())!;
  old.attachGrant(assigned.id, grant(assigned)); old.close();
  const current = new ExecutionStore(database, "b".repeat(64), 1000);
  try {
    expect(current.get(assigned.id).phase).toBe("recovering");
    expect(() => current.renew(assigned.id, assigned.workerId, assigned.slotId, assigned.leaseToken)).toThrow();
    expect(() => current.reserve("worker-a", taskSlot, randomUUID())).toThrow("slot needs");
    current.recover(assigned.id, assigned.workerId, assigned.slotId, assigned.leaseToken);
    const next = current.enqueue(task()); expect(current.reserve("worker-a", taskSlot, randomUUID())?.id).toBe(next.id);
  } finally { current.close(); }
});
