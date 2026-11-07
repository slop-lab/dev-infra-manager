import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { ProcessRunner, type StreamingCommandRunner } from "@slop-lab/dim-host-core";
import { WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import { executionTaskHandlerKind, type ExecutionTaskHandler } from "@slop-lab/dim-contracts-execution/plugin-api";
import { runScheduledTask } from "@slop-lab/dim-service-client-execution/tasks";
import { configuredExecutionServer } from "../../../packages/control-plane/plugins/execution-scheduler/src/service.js";
import { executionServiceConfigSchema } from "../../../packages/control-plane/plugins/execution-scheduler/src/config.js";
import { hostPlugin } from "../../../packages/host/plugins/execution-worker/src/index.js";

// Observe the actual command-selected backend runner; delegate every provider
// lifecycle operation to production code. The task uses that same runner so a
// host-operation cancellation can expose accidental propagation into busy work.
const selected = vi.hoisted(() => ({ runner: undefined as StreamingCommandRunner | undefined }));
vi.mock("../../../packages/host/plugins/execution-worker/src/capacity.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../packages/host/plugins/execution-worker/src/capacity.js")>();
  return { ...actual, async runHostExecutionCapacity(...args: Parameters<typeof actual.runHostExecutionCapacity>) {
    selected.runner = args[2]?.runner;
    return actual.runHostExecutionCapacity(...args);
  } };
});

it("drains the real capacity command without passing host cancellation into its occupied command runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-capacity-command-"));
  const generationId = "a".repeat(64), revision = "b".repeat(64), secret = (n: number) => Buffer.alloc(32, n).toString("base64url");
  const config = executionServiceConfigSchema.parse({ schemaVersion: 1, claimLeaseMilliseconds: 1000,
    credentials: { operator: { username: "operator", password: secret(1) }, tasks: { username: "tasks", password: secret(2) } },
    workers: [{ id: "worker", token: secret(3), slots: [{ id: "task", taskType: "capacity-proof", handlerRevision: revision }] }],
    capacityProviders: [{ id: "pool", token: secret(4), budget: { cpu: 1, memoryBytes: 134217728, pids: 64 },
      members: [{ workerId: "worker", cost: { cpu: 1, memoryBytes: 134217728, pids: 64 } }], maximumStarting: 1,
      idleMilliseconds: 1000, startMilliseconds: 10_000, failureBackoffMilliseconds: 1000 }] });
  // This proves command cancellation, not expiry under unrelated scheduler load.
  // Keep scheduler authority healthy while exercising real HTTP renewals.
  const schedulerNow = Date.now();
  const service = configuredExecutionServer({ now: () => schedulerNow, config, stateDirectory: join(root, "scheduler"), readinessToken: "ready", activationToken: "activate", expectedGenerationId: generationId });
  const renew = vi.spyOn(service.store, "renew");
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const address = service.server.address(); if (!address || typeof address === "string") throw new Error("missing listener");
  const endpoint = `http://127.0.0.1:${address.port}`;
  await fetch(endpoint + "/v1/activation", { method: "POST", headers: { authorization: "Bearer activate", "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, generationId }) });
  const connection = join(root, "connection.json"), workerFile = join(root, "worker.json"), provider = join(root, "capacity.json");
  await writeFile(connection, JSON.stringify({ schemaVersion: 1, role: "capacity-provider", providerId: "pool", generationId, endpoint, credential: { username: "pool", password: secret(4) } }), { mode: 0o600 });
  await writeFile(workerFile, JSON.stringify({ schemaVersion: 1, workerId: "worker", generationId, endpoint, token: secret(3), stateDirectory: join(root, "worker"), slots: [{ id: "task", taskType: "capacity-proof", handlerRevision: revision }] }), { mode: 0o600 });
  await writeFile(provider, JSON.stringify({ schemaVersion: 1, connectionFile: connection, stateDirectory: join(root, "provider"), pollMilliseconds: 1000, members: [{ workerId: "worker", configFile: workerFile }] }), { mode: 0o600 });
  const stop = new AbortController(), commandRunner = new ProcessRunner();
  // This is the signal-combining host runner supplied by executeHostOperation.
  const bound: StreamingCommandRunner = {
    run: (file, args, options = {}) => commandRunner.run(file, args, { ...options, signal: options.signal ? AbortSignal.any([stop.signal, options.signal]) : stop.signal }),
    runStreaming: (file, args, options = {}) => commandRunner.runStreaming(file, args, { ...options, signal: options.signal ? AbortSignal.any([stop.signal, options.signal]) : stop.signal })
  };
  const handler: ExecutionTaskHandler = { taskType: "capacity-proof", revision, async run({ signal }) {
    const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(root, "task.pid"))},String(process.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, "release"))}))process.exit(0)},20);`;
    const result = await (selected.runner ?? new ProcessRunner()).run(process.execPath, ["-e", script], { signal });
    if (result.exitCode !== 0) throw new Error("occupied command was interrupted");
    return { commandSurvived: true };
  }, async cleanup() { return true; } };
  let drained = false;
  const running = hostPlugin.run!(["execution", "capacity", provider], { runner: bound, cleanupRunner: commandRunner, stateRoot: root,
    store: new WorkspaceStore(join(root, "workspace-state")), get service(): never { throw new Error("workspace service must not be accessed"); },
    signal: stop.signal, extensions: [{ kind: executionTaskHandlerKind, name: handler.taskType, value: handler }] }).then(() => { drained = true; });
  const taskStop = new AbortController();
  const task = runScheduledTask({ signal: taskStop.signal, endpoint, generationId, credential: config.credentials.tasks!, taskType: handler.taskType, handlerRevision: revision, payload: {}, async exchange() { throw new Error("unused"); } });
  // Attach immediately so the RED case cannot hide its real failed task result.
  const result = task.then(value => ({ value }), error => ({ error }));
  const diagnostic = () => JSON.stringify({ drained, renewals: renew.mock.calls.length,
    jobs: service.store.list().map(job => ({ phase: job.phase, publication: job.publication, result: job.result?.result })),
    occupied: service.store.occupiedSlots().length });
  async function within<T>(phase: string, operation: Promise<T>, milliseconds = 4000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${phase} did not complete: ${diagnostic()}`)), milliseconds);
    })]); } finally { clearTimeout(timer); }
  }
  try {
    const deadline = Date.now() + 10_000;
    let pid: number;
    for (;;) {
      try { pid = Number(await readFile(join(root, "task.pid"), "utf8")); break; }
      catch { if (Date.now() > deadline) throw new Error("task command did not start"); await delay(20); }
    }
    expect(service.store.occupiedSlots()).toHaveLength(1);
    const renewedBeforeDrain = renew.mock.calls.length;
    stop.abort(); // The same context signal that direct host SIGTERM aborts.
    await delay(6100); // Beyond the transport CLI's separate five-second kill bound.
    expect(renew.mock.calls.length).toBeGreaterThan(renewedBeforeDrain);
    expect(service.store.list()[0]).toMatchObject({ phase: "running", leaseExpiresAt: schedulerNow + config.claimLeaseMilliseconds });
    expect(drained).toBe(false);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(service.store.occupiedSlots()).toHaveLength(1);
    await writeFile(join(root, "release"), "release", { mode: 0o600 });
    expect(await within("task result after release", result)).toEqual({ value: { commandSurvived: true } });
    await within("provider drain after accepted result", running);
    expect(service.store.list()[0]).toMatchObject({ phase: "finished", publication: "accepted", result: { result: "success", cleanupComplete: true } });
  } finally {
    stop.abort(); await writeFile(join(root, "release"), "release", { mode: 0o600 });
    try {
      taskStop.abort(); await within("task cancellation during cleanup", result);
      await within("provider cleanup drain", running);
    } finally {
      await service.close();
      if (drained) await rm(root, { recursive: true, force: true });
      else console.error(`Capacity fixture retained without confirmed drain: ${root}; ${diagnostic()}`);
    }
  }
}, 25_000);
