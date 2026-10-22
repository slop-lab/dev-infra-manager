import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { webPlugin, operations } from "../../../../packages/web/plugins/execution/src/index.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(operator: boolean) {
  const root = await mkdtemp(join(tmpdir(), "dim-execution-web-plugin-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const generationId = "a".repeat(64), calls: string[] = [], mutations: unknown[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`); expect(req.headers["x-dim-generation-id"]).toBe(generationId);
    res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
    if (req.method === "POST") {
      let body = ""; req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      req.on("end", () => { mutations.push(JSON.parse(body)); res.end(JSON.stringify({ id: "00000000-0000-4000-8000-000000000001", taskType: "review-predicate", executionKind: "task/review", phase: "queued", generationId, createdAt: 1, publication: "pending" })); });
      return;
    }
    res.end("[]");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing fixture address");
  const endpoint = `http://127.0.0.1:${address.port}`, queryConnection = join(root, "query.json"), operatorConnection = join(root, "operator.json");
  await writeFile(queryConnection, JSON.stringify({ schemaVersion: 1, role: "query", endpoint, generationId, credential: { username: "query", password: Buffer.alloc(32, 113).toString("base64url") } }), { mode: 0o600 });
  await writeFile(operatorConnection, JSON.stringify({ schemaVersion: 1, role: "operator", endpoint, generationId, credential: { username: "operator", password: Buffer.alloc(32, 111).toString("base64url") } }), { mode: 0o600 });
  return { calls, mutations, queryConnection, config: { queryConnection, ...(operator ? { operatorConnection } : {}) } };
}
it("reads jobs with private query credentials and omits unconfigured execution authority", async () => {
  const selected = await fixture(false), runtime = await webPlugin.create(selected.config);
  expect(await runtime.invoke("jobs.list", {})).toEqual([]);
  expect(runtime.operations?.map((operation) => operation.name)).toEqual(["jobs.list", "jobs.detail"]);
  await expect(runtime.invoke("jobs.cancel", { id: crypto.randomUUID() })).rejects.toThrow("unavailable");
  expect(selected.calls).toEqual(["GET /v1/jobs"]);
  expect(runtime.operations?.map((operation) => operation.name)).not.toContain("controllers.list");
});
it("exposes worker capacity only with a private operator connection", async () => {
  const selected = await fixture(true), runtime = await webPlugin.create(selected.config);
  expect(await runtime.invoke("workers.list", {})).toEqual([]);
  expect(selected.calls).toEqual(["GET /v1/operator/workers"]);
  await chmod(selected.queryConnection, 0o644);
  await expect(webPlugin.create(selected.config)).rejects.toThrow("private CI query");
});
it("rejects path injection and malformed results and requires a retry deduplication key", () => {
  const detail = operations.find((operation) => operation.name === "jobs.detail")!;
  expect(() => detail.parseInput({ id: "../../operator/workers" })).toThrow();
  expect(() => detail.parseOutput({ job: { leaseToken: "secret" } })).toThrow();
  const retry = operations.find((operation) => operation.name === "jobs.retry")!;
  expect(() => retry.parseInput({ id: crypto.randomUUID() })).toThrow();
  expect(retry.parseInput({ id: crypto.randomUUID(), requestId: crypto.randomUUID() })).toHaveProperty("requestId");
});

it("forwards generic execution cancellation and retry with the exact deduplication key", async () => {
  const selected = await fixture(true), runtime = await webPlugin.create(selected.config);
  const id = "00000000-0000-4000-8000-000000000001", requestId = crypto.randomUUID();
  expect(await runtime.invoke("jobs.cancel", { id })).toMatchObject({ taskType: "review-predicate" });
  expect(await runtime.invoke("jobs.retry", { id, requestId })).toMatchObject({ taskType: "review-predicate" });
  expect(selected.calls).toEqual([`POST /v1/operator/jobs/${id}/cancel`, `POST /v1/operator/jobs/${id}/retry`]);
  expect(selected.mutations).toEqual([{}, { requestId }]);
});

it("discovers controllers without Web connection files and pins every execution operation", async () => {
  const calls: string[][] = [];
  const generationId = "a".repeat(64);
  const runtime = await webPlugin.autoConnect!({ controllers: [{ id: "local", async run(args) {
    calls.push([...args]);
    if (args[2] === "describe") return { schemaVersion: 1, generationId, operations: operations.map(({ name, description, access }) => ({ name, description, access })) };
    return [];
  } }] });
  expect(await runtime.invoke("controllers.list", {})).toMatchObject({ controllers: [{ id: "local", controllerKey: "local", status: "ready" }] });
  expect(await runtime.invoke("jobs.list", { controllerId: "local" })).toEqual([]);
  expect(calls.at(-1)).toEqual(["execution", "console", "invoke", "jobs.list", "--expected-generation", generationId, "--input", "{}"]);
  expect(calls[1]).toEqual(["execution", "console", "describe", "--expected-generation", generationId]);
  await expect(runtime.invoke("jobs.list", { controllerId: "foreign" })).rejects.toThrow("unavailable");
  await expect(runtime.invoke("jobs.list", { controllerId: "local", executable: "/bin/sh" })).rejects.toThrow();
});

it("isolates unavailable controllers and rejects changed generations and undeclared authority", async () => {
  let generationId = "a".repeat(64);
  const runtime = await webPlugin.autoConnect!({ controllers: [
    { id: "ready", async run() { return { schemaVersion: 1, generationId, operations: [{ name: "jobs.list", description: "Jobs", access: "read" }] }; } },
    { id: "broken", async run() { throw new Error("private path/password must not escape"); } }
  ] });
  const catalog = await runtime.invoke("controllers.list", {});
  expect(catalog).toMatchObject({ controllers: [{ id: "ready", controllerKey: "ready", status: "ready" }, { id: "broken", controllerKey: "broken", status: "unavailable", operations: [] }] });
  expect(JSON.stringify(catalog)).not.toContain("password");
  await expect(runtime.invoke("jobs.cancel", { controllerId: "ready", id: crypto.randomUUID() })).rejects.toThrow("unavailable");
  generationId = "b".repeat(64);
  expect(await runtime.invoke("controllers.list", {})).toMatchObject({ controllers: [{ id: "ready", status: "unavailable" }, { id: "broken", status: "unavailable" }] });
  await expect(runtime.invoke("jobs.list", { controllerId: "ready" })).rejects.toThrow("unavailable");
  const invalid = await webPlugin.autoConnect!({ controllers: [{ id: "invalid", async run() { return { schemaVersion: 1, generationId, operations: [{ name: "jobs.cancel", description: "Cancel", access: "read" }] }; } }] });
  expect(await invalid.invoke("controllers.list", {})).toMatchObject({ controllers: [{ status: "unavailable" }] });
});
