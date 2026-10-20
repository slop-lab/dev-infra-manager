import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { configuredExecutionServer } from "../../../packages/control-plane/plugins/ci/src/service.js";
import { executionServiceConfigSchema } from "../../../packages/contracts/ci/src/config.js";
import { createCiQueryClient } from "../../../packages/control-plane/admin/src/ci/queryClient.js";
import { registerCiCommands } from "../../../packages/control-plane/admin/src/cli/ci-commands.js";
import { idleOrdinaryConfig } from "../../control-plane/plugins/git-repositories/bundleConfigFixture.js";
import { event, grant, result, generation, slot } from "../../contracts/ci/executionFixture.js";
const { Command } = createRequire(new URL("../../../packages/control-plane/admin/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof registerCiCommands>[0] };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const run of cleanup.splice(0).reverse()) await run(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-ci-query-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const config = executionServiceConfigSchema.parse(idleOrdinaryConfig());
  const ci = configuredExecutionServer({ config, stateDirectory: root, readinessToken: "ready", activationToken: "activate",
    expectedGenerationId: generation, source: { authorize: async (job) => grant(job), candidate: async () => { throw new Error("query must not issue candidate leases"); }, publish: async () => {} } });
  cleanup.push(() => ci.close());
  await new Promise<void>((resolve) => ci.server.listen(0, "127.0.0.1", resolve));
  const address = ci.server.address(); if (!address || typeof address === "string") throw new Error("missing CI listener");
  const endpoint = `http://127.0.0.1:${address.port}`;
  expect((await fetch(`${endpoint}/v1/activation`, { method: "POST", headers: { authorization: "Bearer activate", "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId: generation }) })).status).toBe(200);
  const connection = { schemaVersion: 1, role: "query", endpoint, generationId: generation, credential: config.credentials.query };
  const file = join(root, "ci-query.json"); await writeFile(file, JSON.stringify(connection), { mode: 0o600 });
  await writeFile(join(root, "active-control-plane.json"), JSON.stringify({ schemaVersion: 1,
    hostConnectionFile: join(root, "host.json"), importerConnectionFile: join(root, "importer.json") }), { mode: 0o600 });
  const basic = (username: string, password: string) => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const query = (path: string, credential = config.credentials.query, selectedGeneration: string | undefined = generation) => fetch(`${endpoint}${path}`, {
    headers: { authorization: basic(credential.username, credential.password), ...(selectedGeneration === undefined ? {} : { "x-dim-generation-id": selectedGeneration }) } });
  const queued = ci.store.enqueue(event());
  const assigned = ci.store.reserve("worker-a", slot, randomUUID())!;
  const execution = ci.store.attachGrant(assigned.id, grant(assigned));
  const output = Buffer.alloc(64 * 1024, 0xa5), errorOutput = Buffer.from("candidate diagnostic\n");
  const evidence = result(execution.grant!);
  evidence.stdout = { bytes: String(output.length + 1), sha256: `sha256:${createHash("sha256").update(output).digest("hex")}`, truncated: true };
  evidence.stderr = { bytes: String(errorOutput.length), sha256: `sha256:${createHash("sha256").update(errorOutput).digest("hex")}`, truncated: false };
  evidence.logs = { stdout: { base64: output.toString("base64"), truncated: true }, stderr: { base64: errorOutput.toString("base64"), truncated: false } };
  ci.store.finish(execution.id, "worker-a", slot.id, execution.leaseToken, evidence);
  return { root, ci, config, connection, file, query, queued, execution, output, errorOutput };
}

it("limits recent summaries, protects query roles/generation, and returns diagnostics only for one execution", async () => {
  const f = await fixture();
  for (let index = 0; index < 103; index++) f.ci.store.enqueue(event(`job-${index}`));
  const denied = { username: f.config.workers[0]!.id, password: f.config.workers[0]!.token };
  expect((await f.query("/v1/jobs", denied)).status).toBe(401);
  expect((await f.query("/v1/jobs", f.config.credentials.webhook)).status).toBe(401);
  expect((await f.query("/v1/jobs", f.config.credentials.query, "b".repeat(64))).status).toBe(409);
  const noGeneration = await fetch(`${f.connection.endpoint}/v1/jobs`, { headers: { authorization: `Basic ${Buffer.from(`${f.connection.credential.username}:${f.connection.credential.password}`).toString("base64")}` } });
  expect(noGeneration.status).toBe(409);
  const response = await f.query("/v1/jobs"), jobs = await response.json() as Array<{ id: string; jobName: string }>;
  expect(jobs).toHaveLength(100); expect(jobs[0]?.jobName).toBe("job-102");
  const text = JSON.stringify(jobs); expect(text).not.toContain("logs"); expect(text).not.toContain("leaseToken"); expect(text).not.toContain("descriptor");
  const detail = await f.query(`/v1/jobs/${f.execution.id}`); expect(detail.status).toBe(200);
  const body = JSON.stringify(await detail.json()); expect(body).toContain(f.output.toString("base64")); expect(body).not.toContain(f.execution.leaseToken);
  expect((await f.query(`/v1/jobs/${f.execution.id}`, denied)).status).toBe(401);
  expect((await f.query(`/v1/jobs/${randomUUID()}`)).status).toBe(404);
  const client = await createCiQueryClient(undefined, { DIM_MANAGED_STATE_ROOT: f.root });
  expect(await client.jobs()).toHaveLength(100);
  expect((await client.detail(f.execution.id)).result?.logs.stdout.truncated).toBe(true);
  const stale = join(f.root, "stale.json"); await writeFile(stale, JSON.stringify({ ...f.connection, generationId: "b".repeat(64) }), { mode: 0o600 });
  await expect((await createCiQueryClient(stale)).jobs()).rejects.toThrow(/generation is stale/);
  await chmod(f.file, 0o644); await expect(createCiQueryClient(f.file)).rejects.toThrow(/private CI query connection/);
});

it("runs jobs and byte-preserving logs through the CLI against the real query API", async () => {
  const f = await fixture();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const jobs = new Command(); registerCiCommands(jobs);
  await jobs.parseAsync(["ci", "jobs", "--connection", f.file, "--json"], { from: "user" });
  expect(JSON.parse(String(log.mock.calls[0]?.[0]))[0]).toMatchObject({ id: f.execution.id, outcome: "success" }); log.mockRestore();
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  const out = vi.spyOn(process.stdout, "write").mockImplementation((value) => { stdout.push(Buffer.from(value)); return true; });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((value) => { stderr.push(Buffer.from(value)); return true; });
  try { const logs = new Command(); registerCiCommands(logs); await logs.parseAsync(["ci", "logs", f.execution.id, "--connection", f.file], { from: "user" }); }
  finally { out.mockRestore(); err.mockRestore(); }
  expect(Buffer.concat(stdout)).toEqual(f.output);
  expect(Buffer.concat(stderr).subarray(0, f.errorOutput.length)).toEqual(f.errorOutput);
  expect(Buffer.concat(stderr).toString()).toContain("stdout diagnostics truncated; retained 65536 bytes");
  const malformed = new Command(); registerCiCommands(malformed);
  await expect(malformed.parseAsync(["ci", "logs", "invalid", "--connection", f.file], { from: "user" })).rejects.toThrow(/must be a UUID/);
});
