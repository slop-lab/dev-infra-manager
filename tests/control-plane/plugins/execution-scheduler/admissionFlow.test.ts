import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { configuredExecutionServer } from "../../../../packages/control-plane/plugins/execution-scheduler/src/service.js";
import { GitExecutionAuthorityError, type ExecutionSource } from "../../../../packages/control-plane/plugins/execution-scheduler/src/ci-source.js";
import { event, grant, slot } from "../../../contracts/ci/executionFixture.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const generationId = "a".repeat(64);
const credential = (username: string, byte: number) => ({ username, password: Buffer.alloc(32, byte).toString("base64url") });
const operator = credential("operator", 1), workerToken = Buffer.alloc(32, 2).toString("base64url");

async function fixture(source: ExecutionSource, leaseMilliseconds = 30) {
  const root = await mkdtemp(join(tmpdir(), "dim-admission-flow-")); roots.push(root);
  const activationToken = randomBytes(32).toString("base64url");
  const service = configuredExecutionServer({ config: { schemaVersion: 1, claimLeaseMilliseconds: leaseMilliseconds,
    credentials: { operator, webhook: credential("webhook", 3), query: credential("query", 4) },
    nativeGit: { endpoint: "http://127.0.0.1:9", grantIssuer: credential("grants", 5),
      candidateReader: credential("reader", 6), resultReporter: credential("results", 7) },
    workers: [{ id: "worker-a", token: workerToken, slots: [{ id: slot.id, runtime: "container" as const, profile: slot.profile }] }] }, stateDirectory: root,
    readinessToken: randomBytes(32).toString("base64url"), activationToken, expectedGenerationId: generationId, source });
  await new Promise<void>((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const address = service.server.address(); if (address === null || typeof address === "string") throw new Error("missing listener");
  const endpoint = `http://127.0.0.1:${address.port}`;
  await fetch(`${endpoint}/v1/activation`, { method: "POST", headers: { authorization: `Bearer ${activationToken}` },
    body: JSON.stringify({ schemaVersion: 1, generationId }) });
  return { service, endpoint };
}
const workerHeaders = { authorization: `Basic ${Buffer.from(`worker-a:${workerToken}`).toString("base64")}`,
  "x-dim-generation-id": generationId, "content-type": "application/json" };
const operatorHeaders = { authorization: `Basic ${Buffer.from(`${operator.username}:${operator.password}`).toString("base64")}`,
  "x-dim-generation-id": generationId, "content-type": "application/json" };

it("renews the exact reservation through delayed HTTP authorization", async () => {
  const source: ExecutionSource = { async authorize(assignment, signal) { await delay(80, undefined, { signal }); return grant(assignment); },
    async candidate() { throw new Error("not requested"); }, async publish() {} };
  const running = await fixture(source);
  try {
    const queued = running.service.store.enqueue(event());
    const response = await fetch(`${running.endpoint}/v1/claims`, { method: "POST", headers: workerHeaders,
      body: JSON.stringify({ requestId: randomUUID(), slotId: slot.id }) });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ id: queued.id, phase: "assigned", grant: { executionId: queued.id } });
  } finally { await running.service.close(); }
});

it("requeues typed authorization timeout and exposes only bounded diagnostics", async () => {
  const source: ExecutionSource = { async authorize() { throw new GitExecutionAuthorityError("authorize", "timeout", { cause: new Error("private detail") }); },
    async candidate() { throw new Error("not requested"); }, async publish() {} };
  const running = await fixture(source, 1_000);
  try {
    const queued = running.service.store.enqueue(event());
    const response = await fetch(`${running.endpoint}/v1/claims`, { method: "POST", headers: workerHeaders,
      body: JSON.stringify({ requestId: randomUUID(), slotId: slot.id }) });
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "execution admission failed",
      admission: { phase: "authorize", code: "timeout" } });
    expect(running.service.store.get(queued.id)).toMatchObject({ phase: "queued" });
    expect(running.service.store.get(queued.id)).not.toHaveProperty("admission");
    const summaries = running.service.store.recentSummaries();
    expect(summaries[0]).toMatchObject({ id: queued.id, admission: { phase: "authorize", code: "timeout" } });
    expect(JSON.stringify(summaries)).not.toContain("private detail");
  } finally { await running.service.close(); }
});

it("aborts candidate authority on operator cancellation and never delivers credentials", async () => {
  let candidateStarted!: () => void;
  const started = new Promise<void>((resolve) => { candidateStarted = resolve; });
  const source: ExecutionSource = { async authorize(assignment) { return grant(assignment); },
    async candidate(_grant, signal) { candidateStarted(); await delay(10_000, undefined, { signal }); return { username: "never", password: "never", expiresAt: 1 }; }, async publish() {} };
  const running = await fixture(source, 1_000);
  try {
    const queued = running.service.store.enqueue(event()), requestId = randomUUID();
    const claimed = await fetch(`${running.endpoint}/v1/claims`, { method: "POST", headers: workerHeaders,
      body: JSON.stringify({ requestId, slotId: slot.id }) });
    const assignment = await claimed.json() as { leaseToken: string };
    const pending = fetch(`${running.endpoint}/v1/executions/${queued.id}/candidate`, { method: "POST", headers: workerHeaders,
      body: JSON.stringify({ slotId: slot.id, leaseToken: assignment.leaseToken }) });
    await started;
    const cancelled = await fetch(`${running.endpoint}/v1/operator/jobs/${queued.id}/cancel`, { method: "POST", headers: operatorHeaders, body: "{}" });
    expect(cancelled.status).toBe(200); expect((await pending).status).toBe(503);
    const retained = running.service.store.get(queued.id);
    expect(retained.phase).toBe("recovering"); expect(retained).not.toHaveProperty("result");
  } finally { await running.service.close(); }
});
