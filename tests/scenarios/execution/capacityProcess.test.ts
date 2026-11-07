import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { configuredExecutionServer } from "../../../packages/control-plane/plugins/execution-scheduler/src/service.js";
import { executionServiceConfigSchema } from "../../../packages/control-plane/plugins/execution-scheduler/src/config.js";
import { runScheduledTask } from "@slop-lab/dim-service-client-execution/tasks";
const secret = (n: number) => Buffer.alloc(32, n).toString("base64url");
it("scales from no running worker, executes a real HTTP task in an owned host process and drains without killing busy work", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-capacity-process-")), generationId = "a".repeat(64), revision = "b".repeat(64);
  const config = executionServiceConfigSchema.parse({ schemaVersion: 1, claimLeaseMilliseconds: 1000,
    credentials: { operator: { username: "operator", password: secret(1) }, tasks: { username: "tasks", password: secret(2) } },
    workers: [{ id: "worker", token: secret(3), slots: [{ id: "task", taskType: "capacity-proof", handlerRevision: revision }] }],
    capacityProviders: [{ id: "pool", token: secret(4), budget: { cpu: 1, memoryBytes: 134217728, pids: 64 },
      members: [{ workerId: "worker", cost: { cpu: 1, memoryBytes: 134217728, pids: 64 } }], maximumStarting: 1,
      idleMilliseconds: 1000, startMilliseconds: 10_000, failureBackoffMilliseconds: 1000 }] });
  const service = configuredExecutionServer({ config, stateDirectory: join(root, "scheduler"), readinessToken: "ready", activationToken: "activate", expectedGenerationId: generationId });
  await new Promise<void>(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const address = service.server.address(); if (!address || typeof address === "string") throw new Error("missing listener");
  const endpoint = `http://127.0.0.1:${address.port}`;
  await fetch(endpoint + "/v1/activation", { method: "POST", headers: { authorization: "Bearer activate", "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, generationId }) });
  const connection = join(root, "connection.json"), workerFile = join(root, "worker.json");
  await writeFile(connection, JSON.stringify({ schemaVersion: 1, role: "capacity-provider", providerId: "pool", generationId, endpoint, credential: { username: "pool", password: secret(4) } }), { mode: 0o600 });
  await writeFile(workerFile, JSON.stringify({ schemaVersion: 1, workerId: "worker", generationId, endpoint, token: secret(3), stateDirectory: join(root, "worker"), slots: [{ id: "task", taskType: "capacity-proof", handlerRevision: revision }] }), { mode: 0o600 });
  await writeFile(join(root, "capacity.json"), JSON.stringify({ schemaVersion: 1, connectionFile: connection, stateDirectory: join(root, "provider"), pollMilliseconds: 1000, members: [{ workerId: "worker", configFile: workerFile }] }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href, "--conditions=dim-source", resolve("scenarios/execution/fixtures/capacity-process.ts"), root], { stdio: ["ignore", "pipe", "pipe"], env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DIM_NATIVE_"))) });
  let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += String(b); }); child.stderr.on("data", b => { stderr += String(b); });
  let exit: number | null | undefined; const exited = new Promise<void>(resolve => child.once("exit", code => { exit = code; resolve(); }));
  const taskStop = new AbortController();
  const task = runScheduledTask({ signal: taskStop.signal, endpoint, generationId, credential: config.credentials.tasks!, taskType: "capacity-proof", handlerRevision: revision, payload: {}, async exchange() { throw new Error("unused"); } });
  const deadline = Date.now() + 12_000;
  try {
    for (;;) {
      try { await readFile(join(root, "task-started")); break; } catch {
        if (exit !== undefined || Date.now() > deadline) throw new Error(`capacity worker did not start: ${stderr.slice(-2000)}`);
        await delay(20);
      }
    }
    expect(service.store.occupiedSlots()).toHaveLength(1);
    const duplicate = spawn(process.execPath, ["--import", pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href, "--conditions=dim-source", resolve("scenarios/execution/fixtures/capacity-process.ts"), root], { stdio: "ignore" });
    const duplicateExit = await Promise.race([new Promise<number | null>(resolve => duplicate.once("exit", resolve)), delay(5000).then(() => { duplicate.kill("SIGKILL"); throw new Error("duplicate provider did not refuse its owned guard"); })]);
    expect(duplicateExit).not.toBe(0); // A second provider process cannot apply stale start/stop plans.
    expect(service.store.occupiedSlots()).toHaveLength(1);
    child.kill("SIGTERM"); // Graceful provider shutdown must drain, not abort its occupied worker.
    await delay(1200); expect(exit).toBeUndefined(); expect(service.store.occupiedSlots()).toHaveLength(1);
    await writeFile(join(root, "release-task"), "release", { mode: 0o600 });
    await expect(task).resolves.toEqual({ realHostWorker: true });
    await Promise.race([exited, delay(8000).then(() => { throw new Error("capacity provider did not drain"); })]);
    expect(exit).toBe(0); expect(stdout).toContain("capacity-drained");
    expect(service.store.occupiedSlots()).toEqual([]);
    expect(service.store.list()[0]).toMatchObject({ phase: "finished", publication: "accepted", result: { result: "success", cleanupComplete: true } });
    await expect(readFile(join(root, "worker/task/execution.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (exit === undefined) child.kill("SIGKILL"); await exited;
    taskStop.abort(); await task.catch(() => {}); await service.close(); await rm(root, { recursive: true, force: true });
  }
}, 25_000);
