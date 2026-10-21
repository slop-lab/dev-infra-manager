import { chmod, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { describeHostExecutionConsole, invokeHostExecutionConsole } from "../../../../packages/host/plugins/execution-worker/src/console.js";
import { configuredExecutionServer } from "../../../../packages/control-plane/plugins/execution-scheduler/src/service.js";
import { executionServiceConfigSchema } from "../../../../packages/control-plane/plugins/execution-scheduler/src/config.js";
import { idleExecutionConfig } from "../../../control-plane/plugins/git-repositories/bundleConfigFixture.js";
import { generation, event, grant } from "../../../contracts/ci/executionFixture.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-host-execution-console-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const config = executionServiceConfigSchema.parse(idleExecutionConfig());
  const service = configuredExecutionServer({ config, stateDirectory: join(root, "service"), readinessToken: "ready", activationToken: "activate", expectedGenerationId: generation,
    source: { authorize: async (job) => grant(job), candidate: async () => { throw new Error("unexpected candidate"); }, publish: async () => {} } });
  cleanup.push(() => service.close());
  await new Promise<void>((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const address = service.server.address(); if (!address || typeof address === "string") throw new Error("no listener");
  const endpoint = `http://127.0.0.1:${address.port}`;
  expect((await fetch(`${endpoint}/v1/activation`, { method: "POST", headers: { authorization: "Bearer activate", "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, generationId: generation }) })).status).toBe(200);
  const query = { schemaVersion: 1, role: "query", endpoint, generationId: generation, credential: config.credentials.query };
  const operator = { ...query, role: "operator", credential: config.credentials.operator };
  async function write(name: string, value: unknown) { await writeFile(join(root, name), JSON.stringify(value), { mode: 0o600 }); }
  await write("host.json", { schemaVersion: 1, hostId: "host-a", nativeGit: { generationId: generation } });
  await write("active-control-plane.json", { schemaVersion: 1, hostConnectionFile: join(root, "host.json"), importerConnectionFile: join(root, "importer.json") });
  await write("ci-query.json", query); await write("execution-operator.json", operator);
  return { root, service, config, query, operator, write, env: { DIM_MANAGED_STATE_ROOT: root } };
}
it("discovers selected execution capabilities without Native Git plugin code and forwards validated jobs/cancellation", async () => {
  const f = await fixture(), job = f.service.store.enqueue(event());
  const description = await describeHostExecutionConsole(f.env);
  expect(description).toMatchObject({ schemaVersion: 1, generationId: generation });
  expect(description.operations.map((op) => op.name)).toEqual(["jobs.list", "jobs.detail", "workers.list", "jobs.cancel", "jobs.retry"]);
  for (const secret of [f.root, f.config.credentials.operator.password, f.config.credentials.query!.password, "credential"]) expect(JSON.stringify(description)).not.toContain(secret);
  expect(await invokeHostExecutionConsole("jobs.list", {}, generation, f.env)).toMatchObject([{ id: job.id }]);
  await expect(invokeHostExecutionConsole("jobs.cancel", { id: job.id, command: "evil" }, generation, f.env)).rejects.toThrow();
  expect(f.service.store.get(job.id)?.phase).toBe("queued");
  expect(await invokeHostExecutionConsole("jobs.cancel", { id: job.id }, generation, f.env)).toMatchObject({ id: job.id, phase: "finished" });
  await expect(invokeHostExecutionConsole("jobs.cancel", { id: job.id }, "b".repeat(64), f.env)).rejects.toThrow("generation changed");
});
it("supports read-only generated connections and rejects stale, mixed or falsely labelled role credentials", async () => {
  const f = await fixture();
  await unlink(join(f.root, "execution-operator.json"));
  expect((await describeHostExecutionConsole(f.env)).operations.map((op) => op.name)).toEqual(["jobs.list", "jobs.detail"]);
  await expect(invokeHostExecutionConsole("workers.list", {}, generation, f.env)).rejects.toThrow("unavailable");
  for (const patch of [{ generationId: "b".repeat(64) }, { endpoint: "http://127.0.0.1:1" }, { credential: f.query.credential }, { role: "query" }]) {
    await f.write("execution-operator.json", { ...f.operator, ...patch });
    await expect(describeHostExecutionConsole(f.env)).rejects.toThrow();
  }
  // Different valid-looking credentials still need server-side role attestation.
  await f.write("execution-operator.json", { ...f.operator, credential: f.config.credentials.webhook });
  await expect(describeHostExecutionConsole(f.env)).rejects.toThrow("operator service unavailable");
  await f.write("execution-operator.json", f.operator);
  await f.write("ci-query.json", { ...f.query, generationId: "b".repeat(64) });
  await expect(describeHostExecutionConsole(f.env)).rejects.toThrow("selected control-plane generation");
});
it("rejects public or symlinked controller selection/credentials before requests", async () => {
  const f = await fixture();
  await chmod(join(f.root, "active-control-plane.json"), 0o644);
  await expect(describeHostExecutionConsole(f.env)).rejects.toThrow("private regular files");
  await chmod(join(f.root, "active-control-plane.json"), 0o600);
  await chmod(join(f.root, "ci-query.json"), 0o644);
  await expect(describeHostExecutionConsole(f.env)).rejects.toThrow("private regular files");
  await f.write("query-target.json", f.query);
  await unlink(join(f.root, "ci-query.json"));
  await symlink(join(f.root, "query-target.json"), join(f.root, "ci-query.json"));
  await expect(describeHostExecutionConsole(f.env)).rejects.toThrow();
});
