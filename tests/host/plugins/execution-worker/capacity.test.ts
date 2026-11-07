import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { executionWorkerConfigSchema } from "@slop-lab/dim-contracts-ci/worker";
import { capacityWorkerClean, createHostCapacityAdapter } from "../../../../packages/host/plugins/execution-worker/src/capacity.js";
import { reconcileExecutionCapacity, runExecutionCapacityReconciler, type ExecutionCapacityAdapter } from "../../../../packages/host/plugins/execution-worker/src/capacity-reconciler.js";
import { assignment, generation, grant, result } from "../../../contracts/ci/executionFixture.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-host-capacity-")); roots.push(root);
  const config = executionWorkerConfigSchema.parse({ schemaVersion: 1, workerId: "worker", generationId: generation,
    endpoint: "http://127.0.0.1:9", token: Buffer.alloc(32, 1).toString("base64url"), stateDirectory: root,
    slots: [{ id: "task", taskType: "work", handlerRevision: "b".repeat(64) }] });
  const slot = join(root, "task"); await mkdir(slot, { mode: 0o700 }); return { root, slot, config };
}
it("fences staging roots, temporary/active journals, foreign files and symlinks", async () => {
  const f = await fixture(); expect(await capacityWorkerClean(f.config)).toBe(true);
  for (const name of ["execution.json", ".execution.json.partial", ".work-" + randomUUID() + ".staging", "work-" + randomUUID(), "foreign"]) {
    await writeFile(join(f.slot, name), "{}", { mode: 0o600 });
    expect(await capacityWorkerClean(f.config)).toBe(false); await rm(join(f.slot, name));
  }
  await symlink("/dev/null", join(f.slot, "worker.guard")); expect(await capacityWorkerClean(f.config)).toBe(false);
});
it("retains only complete validated terminal artifact receipts and refuses pending/malformed markers", async () => {
  const f = await fixture(), id = randomUUID(), pending = join(f.slot, "artifacts-" + id); await mkdir(pending, { mode: 0o700 });
  expect(await capacityWorkerClean(f.config)).toBe(false);
  const g = grant({ ...assignment(), id }), commandResult = result(g);
  const manifest = { executionId: id, descriptorDigest: g.descriptorDigest, availability: "complete", artifacts: [] };
  await writeFile(join(pending, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  const marker = join(pending, "upload-interrupted.json"); await writeFile(marker, '{"schemaVersion":', { mode: 0o600 });
  expect(await capacityWorkerClean(f.config)).toBe(false);
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, executionId: id, deadlineAt: 1000, reason: "execution-lease-lost", commandResult }), { mode: 0o600 });
  const original = await readFile(marker); expect(await capacityWorkerClean(f.config)).toBe(true); expect(await readFile(marker)).toEqual(original);
  await writeFile(join(pending, ".manifest.tmp"), "", { mode: 0o600 }); expect(await capacityWorkerClean(f.config)).toBe(false);
});
it("starts the pinned parsed worker identity even if its original file is later edited, and fences stale stops", async () => {
  const f = await fixture(), file = join(f.root, "worker.json"); await writeFile(file, JSON.stringify(f.config), { mode: 0o600 });
  const pinned = executionWorkerConfigSchema.parse(JSON.parse(await readFile(file, "utf8")));
  let firstStopped = false;
  const run = vi.fn(async (config: ReturnType<typeof executionWorkerConfigSchema.parse>, signal: AbortSignal) => {
    expect(config).toEqual(pinned); await new Promise<void>(resolve => signal.addEventListener("abort", () => { firstStopped = true; resolve(); }, { once: true }));
  });
  const adapter = createHostCapacityAdapter([pinned], run);
  await writeFile(file, JSON.stringify({ ...f.config, workerId: "foreign", endpoint: "http://127.0.0.1:8" }), { mode: 0o600 });
  await adapter.start("worker"); const old = await adapter.observe("worker"); expect(run).toHaveBeenCalledTimes(1);
  await expect(adapter.stop("worker", "stale-instance")).rejects.toThrow("instance"); expect(firstStopped).toBe(false);
  await adapter.stop("worker", old.instance!); expect(firstStopped).toBe(true);
  await adapter.start("worker"); const current = await adapter.observe("worker"); expect(current.instance).not.toBe(old.instance);
  await expect(adapter.stop("worker", old.instance!)).rejects.toThrow("instance"); await adapter.stop("worker", current.instance!);
});
it("requires fresh stop authorization plus matching local instance/clean journals and leaves workers on transport failure", async () => {
  let clean = false, stopped = false;
  const adapter: ExecutionCapacityAdapter = { async observe(workerId) { return { workerId, state: "running", clean, instance: "owned" }; },
    async start() { throw new Error("unexpected start"); }, async stop(_worker, instance) { expect(instance).toBe("owned"); stopped = true; } };
  const authorizeStop = vi.fn(async () => {});
  const client = { generationId: generation, providerId: "pool", authorizeStop,
    async reconcile() { return { schemaVersion: 1 as const, generationId: generation, providerId: "pool", workers: [{ workerId: "worker", revision: 4, state: "draining" as const, action: "stop" as const }] }; } };
  await reconcileExecutionCapacity({ workerIds: ["worker"], adapter, client, drain: true }); expect(stopped).toBe(false); expect(authorizeStop).not.toHaveBeenCalled();
  clean = true; await reconcileExecutionCapacity({ workerIds: ["worker"], adapter, client, drain: true }); expect(stopped).toBe(true); expect(authorizeStop).toHaveBeenCalledWith("worker", 4);
  stopped = false; await expect(reconcileExecutionCapacity({ workerIds: ["worker"], adapter, client: { ...client, async reconcile() { throw new Error("offline"); } }, drain: false })).rejects.toThrow("offline"); expect(stopped).toBe(false);
});

it("does not apply a pending start plan after shutdown begins during its network read", async () => {
  const stop = new AbortController(), start = vi.fn(async () => {});
  const adapter: ExecutionCapacityAdapter = { async observe(workerId) { return { workerId, state: "stopped", clean: true }; }, start, async stop() {} };
  const client = { generationId: generation, providerId: "pool", async authorizeStop() {}, async reconcile() {
    stop.abort(); return { schemaVersion: 1 as const, generationId: generation, providerId: "pool", workers: [{ workerId: "worker", revision: 1, state: "starting" as const, action: "start" as const }] };
  } };
  await reconcileExecutionCapacity({ workerIds: ["worker"], adapter, client, signal: stop.signal, drain: false });
  expect(start).not.toHaveBeenCalled();
});

it("keeps shutdown fenced when local observation fails instead of exiting with unknown worker ownership", async () => {
  const signal = AbortSignal.abort(), report = vi.fn(); let failures = 2, clean = false, running = true, returned = false;
  const adapter: ExecutionCapacityAdapter = { async observe(workerId) {
    if (failures-- > 0) throw new Error("local journal temporarily unreadable");
    return { workerId, state: running ? "running" : "stopped", clean, instance: "owned" };
  }, async start() { throw new Error("unexpected"); }, async stop() { running = false; } };
  const client = { generationId: generation, providerId: "pool", async authorizeStop() {}, async reconcile() {
    return { schemaVersion: 1 as const, generationId: generation, providerId: "pool", workers: [{ workerId: "worker", revision: 1, state: "draining" as const, action: clean ? "stop" as const : "keep" as const }] };
  } };
  const loop = runExecutionCapacityReconciler({ workerIds: ["worker"], adapter, client, signal, pollMilliseconds: 1, report }).then(() => { returned = true; });
  await vi.waitFor(() => { expect(report).toHaveBeenCalled(); expect(failures).toBeLessThanOrEqual(0); });
  expect(returned).toBe(false); expect(running).toBe(true);
  clean = true; await loop; expect(returned).toBe(true); expect(running).toBe(false);
});
