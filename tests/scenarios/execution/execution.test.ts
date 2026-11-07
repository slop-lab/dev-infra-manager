import { executionCandidateLeaseLifetimeMilliseconds } from "@slop-lab/dim-contracts-ci/execution";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ExecutionStore } from "../../../packages/control-plane/plugins/execution-scheduler/src/store.js";
import { runExecutionWorker } from "../../../packages/host/plugins/execution-worker/src/worker.js";
import { ExecutionServiceUnavailableError, type ExecutionWorkerClient } from "../../../packages/host/plugins/execution-worker/src/client.js";
import { NativeOutputCollector, executionDiagnostics } from "../../../packages/host/plugins/execution-worker/src/output.js";
import type { ExecutionBackend } from "../../../packages/host/plugins/execution-worker/src/backend.js";
import { ProcessRunner } from "../../../packages/host/core/src/runner.js";
import { generation, event, grant, result, slot, assignment, hash } from "../../contracts/ci/executionFixture.js";
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
it.each([0, 40])("fences pre-grant admission deterministically with %i ms of simulated renewal stall", async (stall) => {
  let now = 0;
  const store = new ExecutionStore(join(await root(), "executions.sqlite3"), generation, 30, () => now);
  try {
    store.enqueue(event()); const claim = store.reserve("worker-a", slot, randomUUID());
    if (!claim) throw new Error("expected an owned pre-grant reservation");
    const operation = Promise.withResolvers<ReturnType<typeof grant>>();
    const pending = runAdmission({ store, assignment: claim, granted: false, signal: new AbortController().signal,
      operation: () => operation.promise,
      async wait(milliseconds) { now += milliseconds + stall; operation.resolve(grant(claim)); } });
    if (stall === 0) {
      const authorized = await pending;
      expect(store.attachGrant(claim.id, authorized).grant).toEqual(authorized);
      expect(store.get(claim.id).leaseExpiresAt).toBeGreaterThan(30);
    } else {
      await expect(pending).rejects.toThrow();
      expect(store.get(claim.id).phase).toBe("recovering");
      expect(store.get(claim.id)).not.toHaveProperty("grant");
    }
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
    const credential = await delayed({ username: "candidate", password: "a".repeat(43), expiresAt: now + executionCandidateLeaseLifetimeMilliseconds }, true);
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
    async artifactChunk() {}, async finalizeArtifacts() {},
    async claim(requestId) { return { ...authorized, requestId }; }, async renew() { return 60_000; },
    async candidate() { return { username: "candidate", password: "a".repeat(43), expiresAt: Date.now() + executionCandidateLeaseLifetimeMilliseconds }; },
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

it("retries durable artifact uploads after worker restart without reexecuting candidate code", async () => {
  const directory = await root(), stop = new AbortController(), selected = assignment();
  const authorized = { ...selected, grant: grant(selected) }; let launches = 0, finalizations = 0, reports = 0;
  const backend: ExecutionBackend = { kind: "ordinary-sysbox", async run() { launches++; return result(authorized.grant); }, async cleanup() { return true; } };
  const client: ExecutionWorkerClient = {
    async claim(requestId) { return { ...authorized, requestId }; }, async renew() { return 60_000; },
    async candidate() { return { username: "candidate", password: "a".repeat(43), expiresAt: Date.now()+executionCandidateLeaseLifetimeMilliseconds }; },
    async exchange() { throw new Error("unused"); }, async recover() { throw new Error("must report completed execution"); },
    async artifactChunk() {},
    async finalizeArtifacts() { if (++finalizations === 1) throw new Error("worker interrupted after artifact transmission"); },
    async report() { reports++; stop.abort(); }
  };
  const options = { directory, client, backend, runner: new ProcessRunner(), gitEndpoint: "http://127.0.0.1:1234", gitExecutable: "/usr/bin/git", signal: stop.signal };
  await expect(runExecutionWorker(options)).rejects.toThrow("worker interrupted after artifact transmission");
  const journal = JSON.parse(await readFile(join(directory,"execution.json"),"utf8"));
  expect(journal.pendingResult.result).toBe("success"); expect(journal.result).toBeUndefined();
  expect(JSON.parse(await readFile(join(directory,"artifacts-"+authorized.id,"manifest.json"),"utf8")).availability).toBe("complete");
  await runExecutionWorker(options);
  expect(launches).toBe(1); expect(finalizations).toBe(2); expect(reports).toBe(1);
  await expect(readFile(join(directory,"execution.json"))).rejects.toMatchObject({code:"ENOENT"});
  await expect(readFile(join(directory,"artifacts-"+authorized.id,"manifest.json"))).rejects.toMatchObject({code:"ENOENT"});
});

it("closes an upload outage at its persisted deadline despite healthy lease renewals and retains local failure proof", async () => {
  const directory = await root(), stop = new AbortController();
  const watchdog = setTimeout(() => stop.abort(new Error("upload deadline did not release the worker")), 2_000);
  const store = new ExecutionStore(join(directory, "scheduler.sqlite3"), generation, 90);
  try {
    store.enqueue(event());
    const selected = store.reserve("worker-a", slot, randomUUID())!, authorized = store.attachGrant(selected.id, grant(selected));
    let launches = 0, renewals = 0;
    const bytes = Buffer.alloc(90_000, 37);
    const backend: ExecutionBackend = {
      kind: "ordinary-sysbox",
      async run(input) {
        launches++;
        const output = new NativeOutputCollector(100_000, () => { throw new Error("unexpected output limit"); }, join(input.root, "output"));
        output.stdout.write(bytes); const captured = output.result();
        return { ...result(authorized.grant!), stdout: captured.stdoutEvidence, stderr: captured.stderrEvidence, logs: executionDiagnostics(captured) };
      },
      async cleanup() { return true; },
    };
    const client: ExecutionWorkerClient = {
      async claim() { return authorized; },
      async renew(assignment) { renewals++; store.renew(assignment.id, assignment.workerId, assignment.slotId, assignment.leaseToken); return 90; },
      async candidate() { return { username: "candidate", password: "a".repeat(43), expiresAt: Date.now() + executionCandidateLeaseLifetimeMilliseconds }; },
      async artifactChunk() { throw new ExecutionServiceUnavailableError("artifact storage unavailable", "unavailable"); },
      async finalizeArtifacts() { throw new Error("unreachable"); },
      async exchange() { throw new Error("unused"); }, async recover() { throw new Error("must report failure"); },
      async report(assignment, completed) { store.finish(assignment.id, assignment.workerId, assignment.slotId, assignment.leaseToken, completed); stop.abort(); },
    };
    await runExecutionWorker({ directory, client, backend, runner: new ProcessRunner(), gitEndpoint: "http://127.0.0.1:1234",
      gitExecutable: "/usr/bin/git", signal: stop.signal, artifactUploadTimeoutMilliseconds: 180 });
    expect(launches).toBe(1); expect(renewals).toBeGreaterThan(1);
    const finished = store.get(authorized.id);
    expect(finished.phase).toBe("finished"); expect(finished.result).toMatchObject({ result: "failure", completion: { kind: "executor-failure", code: "artifact-upload-timeout" } });
    expect(finished.result && "stdout" in finished.result ? finished.result.stdout : undefined).toEqual({ bytes: "90000", sha256: `sha256:${hash(bytes.toString())}`, truncated: false });
    const pending = join(directory, `artifacts-${authorized.id}`);
    expect(await readFile(join(pending, hash("logs/stdout.log")))).toEqual(bytes);
    const receipt = await readFile(join(pending, "upload-timeout.json"), "utf8");
    expect(JSON.parse(receipt)).toMatchObject({ commandResult: { result: "success" }, reportedFailure: { result: "failure" } });
    expect(receipt).not.toContain(authorized.leaseToken);
    await expect(readFile(join(directory, "execution.json"))).rejects.toMatchObject({ code: "ENOENT" });
    store.enqueue(event("next")); const next = store.reserve("worker-a", slot, randomUUID());
    expect(next?.id).not.toBe(authorized.id); expect(next?.event.jobName).toBe("next");
  } finally { clearTimeout(watchdog); store.close(); }
});

it("does not renew an interrupted artifact upload's deadline or reexecute its candidate after restart", async () => {
  const directory = await root(), firstStop = new AbortController(), selected = assignment(), authorized = { ...selected, grant: grant(selected) };
  let launches = 0, uploads = 0, reports = 0;
  const backend: ExecutionBackend = { kind: "ordinary-sysbox", async run() { launches++; return result(authorized.grant); }, async cleanup() { return true; } };
  const client: ExecutionWorkerClient = {
    async claim() { return authorized; }, async renew() { return 90; },
    async candidate() { return { username: "candidate", password: "a".repeat(43), expiresAt: Date.now() + executionCandidateLeaseLifetimeMilliseconds }; },
    async artifactChunk() { uploads++; firstStop.abort(); throw new ExecutionServiceUnavailableError("interrupted upload", "unavailable"); },
    async finalizeArtifacts() {}, async exchange() { throw new Error("unused"); }, async recover() { throw new Error("must report failure"); },
    async report(_assignment, completed) { reports++; expect(completed).toMatchObject({ result: "failure", completion: { code: "artifact-upload-timeout" } }); },
  };
  const common = { directory, client, backend, runner: new ProcessRunner(), gitEndpoint: "http://127.0.0.1:1234", gitExecutable: "/usr/bin/git", artifactUploadTimeoutMilliseconds: 500 };
  await expect(runExecutionWorker({ ...common, signal: firstStop.signal })).rejects.toBeDefined();
  const before = JSON.parse(await readFile(join(directory, "execution.json"), "utf8"));
  expect(before.artifactUploadDeadlineAt).toEqual(expect.any(Number)); expect(before.pendingResult.result).toBe("success");
  await delay(Math.max(1, before.artifactUploadDeadlineAt - Date.now() + 10));
  const nextStop = new AbortController();
  const watchdog = setTimeout(() => nextStop.abort(new Error("restart reset the upload deadline")), 2_000);
  client.report = async (_assignment, completed) => {
    reports++; expect(completed).toMatchObject({ result: "failure", completion: { code: "artifact-upload-timeout" } }); nextStop.abort();
  };
  try { await runExecutionWorker({ ...common, signal: nextStop.signal, artifactUploadTimeoutMilliseconds: 300_000 }); }
  finally { clearTimeout(watchdog); }
  expect(launches).toBe(1); expect(uploads).toBe(1); expect(reports).toBe(1);
  const receipt = JSON.parse(await readFile(join(directory, `artifacts-${authorized.id}`, "upload-timeout.json"), "utf8"));
  expect(receipt.deadlineAt).toBe(before.artifactUploadDeadlineAt);
  expect(receipt.commandResult).toEqual(before.pendingResult);
});

it("publishes initial credential failure diagnostics through the real backend and artifact cleanup path", async () => {
  const { sysboxBackend } = await import("../../../packages/host/plugins/execution-worker/src/backends/sysbox.js");
  const { ExecutorRunner } = await import("../../host/plugins/execution-worker/sysboxFixture.js");
  const { readdir } = await import("node:fs/promises");
  const directory = await root(), stop = new AbortController(), selected = assignment();
  const authorized = { ...selected, grant: grant(selected) }, runner = new ExecutorRunner();
  const chunks: string[] = []; let reports = 0, leaseRequests = 0;
  const client: ExecutionWorkerClient = {
    async claim(requestId) { return { ...authorized, requestId }; }, async renew() { return 60_000; },
    async candidate() { leaseRequests++; throw new ExecutionServiceUnavailableError("secret://credential@service/private", "timeout"); },
    async exchange() { throw new Error("not a generic task"); }, async recover() { throw new Error("failed evidence must be reported"); },
    async artifactChunk(_assignment, value) {
      if (value !== null && typeof value === "object" && "base64" in value && typeof value.base64 === "string") chunks.push(Buffer.from(value.base64, "base64").toString());
    },
    async finalizeArtifacts() {},
    async report(_assignment, completed) {
      reports++;
      expect(completed).toMatchObject({ completion: { kind: "executor-failure", code: "candidate-read-timeout" }, cleanupComplete: true, result: "failure" });
      stop.abort();
    }
  };
  await runExecutionWorker({ directory, client, backend: sysboxBackend, runner, gitEndpoint: "http://127.0.0.1:1234", gitExecutable: "/usr/bin/git", signal: stop.signal });
  expect(leaseRequests).toBe(1); expect(reports).toBe(1);
  expect(chunks.join("")).toContain('{"component":"candidate-acquisition","phase":"credential-acquisition","code":"candidate-read-timeout"}');
  expect(chunks.join("")).not.toContain("secret://");
  expect(runner.calls.some(({ args }) => args[0] === "run" || args[0] === "wait")).toBe(false);
  expect((await readdir(directory)).some(name => name.startsWith("work-") || name.startsWith("artifacts-") || name === "execution.json")).toBe(false);
});
