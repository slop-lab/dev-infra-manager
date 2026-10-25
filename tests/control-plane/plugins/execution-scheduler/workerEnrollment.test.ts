import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configuredExecutionServer } from "../../../../packages/control-plane/plugins/execution-scheduler/src/service.js";
import { enrollExecutionWorker, exportExecutionWorker } from "../../../../packages/host/plugins/execution-worker/src/enrollment.js";
import { executionWorkerConfigSchema } from "@slop-lab/dim-contracts-ci/worker";
import { executionWorkerClient } from "../../../../packages/host/plugins/execution-worker/src/client.js";
import { runExecutionWorker } from "../../../../packages/host/plugins/execution-worker/src/worker.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const generationId = "a".repeat(64);
const credential = (username: string, byte: number) => ({ username, password: Buffer.alloc(32, byte).toString("base64url") });
const operator = credential("operator", 1);
const query = credential("query", 2);
const tasks = credential("tasks", 3);
const webhook = credential("webhook", 4);
const capacity = {
  schemaVersion: 1,
  workerId: "ci-added",
  slots: [{ id: "ci-added-1", runtime: "container", profile: {
    runnerBaseImage: `registry.example/runner@sha256:${"b".repeat(64)}`,
    jobBaseImage: `registry.example/job@sha256:${"c".repeat(64)}`,
    bounds: { cpu: "1", memoryBytes: "2147483648", pids: "512", wallClockSeconds: "900", outputBytes: "1048576" }
  } }]
} as const;

async function fixture(root: string, now?: () => number) {
  const activationToken = randomBytes(32).toString("base64url");
  const service = configuredExecutionServer({ config: { schemaVersion: 1, claimLeaseMilliseconds: 30_000,
    nativeGit: { endpoint: "http://127.0.0.1:9", grantIssuer: credential("grants", 5), candidateReader: credential("reader", 6), resultReporter: credential("results", 7) },
    credentials: { operator, query, tasks, webhook }, workers: [] }, stateDirectory: root,
    readinessToken: randomBytes(32).toString("base64url"), activationToken, expectedGenerationId: generationId,
    ...(now === undefined ? {} : { now }) });
  await new Promise<void>((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const address = service.server.address();
  if (address === null || typeof address === "string") throw new Error("missing execution listener");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const activated = await fetch(`${endpoint}/v1/activation`, { method: "POST", headers: {
    authorization: `Bearer ${activationToken}`, "content-type": "application/json"
  }, body: JSON.stringify({ schemaVersion: 1, generationId }) });
  expect(activated.status).toBe(200);
  return { endpoint, service };
}

function headers(selected = operator, generation = generationId) {
  return { authorization: `Basic ${Buffer.from(`${selected.username}:${selected.password}`).toString("base64")}`,
    "x-dim-generation-id": generation, "content-type": "application/json" };
}

it("enrolls operator-reviewed capacity and persists it across scheduler restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-worker-enrollment-")); roots.push(root);
  const first = await fixture(root);
  const enrolled = await fetch(`${first.endpoint}/v1/operator/workers/enroll`, {
    method: "POST", headers: headers(), body: JSON.stringify(capacity)
  });
  expect(enrolled.status).toBe(200);
  const secret = await enrolled.json() as { token: string };
  expect(secret.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await first.service.close();

  const second = await fixture(root);
  try {
    const workers = await fetch(`${second.endpoint}/v1/operator/workers`, { headers: headers() });
    expect(await workers.json()).toEqual([{ id: "ci-added", observedConnected: false, slots: [{
      id: "ci-added-1", executionKind: "ordinary-sysbox", state: "idle", available: false
    }] }]);
    const exported = await fetch(`${second.endpoint}/v1/operator/workers/ci-added/export`, { method: "POST", headers: headers(), body: "{}" });
    expect(exported.status).toBe(200);
    const exportedBody = await exported.json();
    expect(exportedBody).toMatchObject({ ...capacity, generationId, token: secret.token });
    const repeated = await fetch(`${second.endpoint}/v1/operator/workers/ci-added/export`, { method: "POST", headers: headers(), body: "{}" });
    expect(await repeated.json()).toEqual(exportedBody);
  } finally { await second.service.close(); }
});

it("rejects non-operator, stale, duplicate and changed enrollment requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-worker-enrollment-auth-")); roots.push(root);
  const running = await fixture(root);
  try {
    const request = (selected: typeof operator, generation: string, body: unknown) => fetch(`${running.endpoint}/v1/operator/workers/enroll`, {
      method: "POST", headers: headers(selected, generation), body: JSON.stringify(body)
    });
    expect((await request(query, generationId, capacity)).status).toBe(401);
    expect((await request(operator, "d".repeat(64), capacity)).status).toBe(409);
    expect((await request(operator, generationId, capacity)).status).toBe(200);
    expect((await request(operator, generationId, capacity)).status).toBe(409);
    expect((await request(operator, generationId, { ...capacity, slots: [{ ...capacity.slots[0], id: "changed" }] })).status).toBe(409);
    expect((await request(operator, generationId, { ...capacity, workerId: "ci-other" })).status).toBe(200);
  } finally { await running.service.close(); }
});

it("reports bounded recent contact rather than permanent worker health", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-worker-enrollment-observed-")); roots.push(root);
  let now = 1_000;
  const running = await fixture(root, () => now);
  try {
    const enrolled = await fetch(`${running.endpoint}/v1/operator/workers/enroll`, {
      method: "POST", headers: headers(), body: JSON.stringify(capacity)
    });
    const secret = await enrolled.json() as { token: string };
    const workerHeaders = { authorization: `Basic ${Buffer.from(`ci-added:${secret.token}`).toString("base64")}`,
      "x-dim-generation-id": generationId };
    expect((await fetch(`${running.endpoint}/v1/claims`, { method: "POST", headers: { ...workerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID(), slotId: "not-enrolled" }) })).status).toBe(404);
    expect((await fetch(`${running.endpoint}/v1/worker`, { headers: workerHeaders })).status).toBe(200);
    const workers = await fetch(`${running.endpoint}/v1/operator/workers`, { headers: headers() });
    expect(await workers.json()).toMatchObject([{ id: "ci-added", observedConnected: true,
      lastSeenAt: 1_000, slots: [{ id: "ci-added-1", state: "idle", available: true }] }]);
    now = 31_001;
    const expired = await fetch(`${running.endpoint}/v1/operator/workers`, { headers: headers() });
    expect(await expired.json()).toMatchObject([{ id: "ci-added", observedConnected: false,
      lastSeenAt: 1_000, slots: [{ id: "ci-added-1", available: false }] }]);
    expect((await fetch(`${running.endpoint}/v1/not-a-worker-route`, { headers: workerHeaders })).status).toBe(404);
    const refreshed = await fetch(`${running.endpoint}/v1/operator/workers`, { headers: headers() });
    expect(await refreshed.json()).toMatchObject([{ id: "ci-added", observedConnected: true, lastSeenAt: 31_001 }]);
  } finally { await running.service.close(); }
});

it("writes an enrolled worker config only to a new private absolute output", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-worker-enrollment-file-")); roots.push(root);
  const running = await fixture(join(root, "state"));
  try {
    const connectionFile = join(root, "operator.json"), specFile = join(root, "capacity.json"), outputFile = join(root, "worker.json");
    await writeFile(connectionFile, JSON.stringify({ schemaVersion: 1, role: "operator", endpoint: running.endpoint,
      generationId, credential: operator }), { mode: 0o600 });
    await writeFile(specFile, JSON.stringify({ ...capacity, stateDirectory: join(root, "worker-state"),
      gitExecutable: "/usr/bin/git", nativeGitEndpoint: "http://127.0.0.1:8080" }), { mode: 0o600 });
    await enrollExecutionWorker({ connectionFile, specFile, outputFile });
    expect((await stat(outputFile)).mode & 0o777).toBe(0o600);
    expect(executionWorkerConfigSchema.parse(JSON.parse(await readFile(outputFile, "utf8")))).toMatchObject({
      workerId: capacity.workerId, endpoint: running.endpoint, generationId, slots: [{ id: "ci-added-1", runtime: "container" }]
    });
    const exportedFile = join(root, "exported-worker.json");
    await exportExecutionWorker({ connectionFile, specFile, outputFile: exportedFile });
    expect(JSON.parse(await readFile(exportedFile, "utf8"))).toEqual(JSON.parse(await readFile(outputFile, "utf8")));
    await writeFile(specFile, JSON.stringify({ ...capacity, stateDirectory: join(root, "worker-state"),
      gitExecutable: "/usr/bin/git", nativeGitEndpoint: "http://127.0.0.1:8080",
      slots: [{ ...capacity.slots[0], profile: { ...capacity.slots[0].profile, jobBaseImage: `registry.example/changed@sha256:${"d".repeat(64)}` } }] }), { mode: 0o600 });
    const mismatchOutput = join(root, "mismatch-worker.json");
    await expect(exportExecutionWorker({ connectionFile, specFile, outputFile: mismatchOutput })).rejects.toThrow("differs");
    await expect(stat(mismatchOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(enrollExecutionWorker({ connectionFile, specFile, outputFile })).rejects.toThrow("already exists");
    await chmod(specFile, 0o644);
    await expect(enrollExecutionWorker({ connectionFile, specFile, outputFile: join(root, "unsafe.json") })).rejects.toThrow("mode-0600");
    await chmod(specFile, 0o600);
    const staleConnection = join(root, "stale-operator.json"), retryOutput = join(root, "retry-worker.json");
    await writeFile(staleConnection, JSON.stringify({ schemaVersion: 1, role: "operator", endpoint: running.endpoint,
      generationId: "f".repeat(64), credential: operator }), { mode: 0o600 });
    await expect(enrollExecutionWorker({ connectionFile: staleConnection, specFile, outputFile: retryOutput })).rejects.toThrow("conflicts");
    await expect(stat(retryOutput)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await running.service.close(); }
});

it("fails startup when durable worker authority conflicts with a service role", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-worker-enrollment-conflict-")); roots.push(root);
  const running = await fixture(root);
  running.service.store.database.prepare("INSERT INTO enrolled_workers(worker_id,generation_id,body) VALUES (?,?,?)").run(
    "query", generationId, JSON.stringify({ schemaVersion: 1, workerId: "query", generationId,
      token: randomBytes(32).toString("base64url"), slots: [{ id: "shared", taskType: "fixture", handlerRevision: "e".repeat(64) }] }));
  await running.service.close();
  await expect(fixture(root)).rejects.toThrow("service role");
});

it("lets an enrolled task worker claim, run and report through the real worker loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-worker-enrollment-run-")); roots.push(root);
  const running = await fixture(join(root, "state"));
  const revision = "e".repeat(64), workerId = "task-added", slotId = "task-added-1";
  try {
    const enrolled = await fetch(`${running.endpoint}/v1/operator/workers/enroll`, { method: "POST", headers: headers(),
      body: JSON.stringify({ schemaVersion: 1, workerId, slots: [{ id: slotId, taskType: "fixture", handlerRevision: revision }] }) });
    const secret = await enrolled.json() as { token: string };
    const submitted = await fetch(`${running.endpoint}/v1/tasks`, { method: "POST", headers: headers(tasks), body: JSON.stringify({
      requestId: randomUUID(), taskType: "fixture", handlerRevision: revision, payload: { reviewed: true }
    }) });
    expect(submitted.status).toBe(200);
    const { executionId } = await submitted.json() as { executionId: string };
    const stop = new AbortController();
    let reported!: () => void;
    const completed = new Promise<void>((resolve) => { reported = resolve; });
    const client = executionWorkerClient({ endpoint: running.endpoint, generationId, workerId, slotId, token: secret.token });
    const worker = runExecutionWorker({ directory: join(root, "slot"), signal: stop.signal, client: {
      ...client, async report(assignment, result, signal) { await client.report(assignment, result, signal); reported(); }
    }, taskHandlers: [{ taskType: "fixture", revision, async run() { return { reviewed: true }; }, async cleanup() { return true; } }] });
    await completed; stop.abort(); await worker;
    expect(running.service.store.get(executionId)).toMatchObject({ phase: "finished", result: { result: "success", value: { reviewed: true } } });
  } finally { await running.service.close(); }
});
