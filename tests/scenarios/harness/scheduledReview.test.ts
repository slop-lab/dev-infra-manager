import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";
import type { ExecutionTaskHandler } from "@slop-lab/dim-contracts-execution/plugin-api";
import { runScheduledTask } from "@slop-lab/dim-execution-client/tasks";
import { createScheduledReviewTraceRuntime } from "../../../packages/control-plane/plugins/review-tracing-scheduled/src/index.js";
import { loadExampleRecipe, resolveExamplePath } from "../../../scripts/examples/recipe.js";

import { schedulerFixture, startWorker, generationId, credential, secret } from "../../support/scheduled-trace.js";

async function scheduledRecipe() {
  const recipe = await loadExampleRecipe(fileURLToPath(new URL("../../../examples/features/scheduled-review", import.meta.url)));
  assert.deepEqual(recipe.plugins, {
    host: ["@slop-lab/dim-host-plugin-execution-worker@0.10.0", "@slop-lab/dim-host-plugin-review-tracing-node@0.10.0"],
    controlPlane: ["@slop-lab/dim-control-plane-plugin-execution-scheduler@0.10.0", "@slop-lab/dim-control-plane-plugin-review-tracing-scheduled@0.10.0"]
  });
  assert.deepEqual(recipe.repositories, [{ id: "root", path: "repository" }]);
  return recipe;
}

it("declares the scheduled runtime's required plugins and strictly type-checks its repository template", async () => {
  const recipe = await scheduledRecipe();
  const directory = await mkdtemp(join(tmpdir(), "dim-scheduled-template-types-"));
  try {
    const project = join(directory, "project");
    await cp(resolveExamplePath(recipe, "repository"), project, { recursive: true });
    const scope = join(project, "node_modules/@slop-lab");
    await mkdir(scope, { recursive: true });
    await symlink(fileURLToPath(new URL("../../../packages/review-tracing/runtimes/node", import.meta.url)), join(scope, "dim-review-tracing-node"), "dir");
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url)),
      "-p", join(project, "tsconfig.json"), "--noEmit", "--customConditions", "dim-source"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert(Date.now() < deadline, "scheduled task did not reach the expected state");
    await delay(10);
  }
}

it("uses scheduler capacity and lease renewal for brokered tasks without Native Git authority", async () => {
  const revision = "f".repeat(64);
  const fixture = await schedulerFixture(revision);
  let cleaned = false, launches = 0;
  const handler: ExecutionTaskHandler = { taskType: "review-tracing", revision,
    async run({ payload, exchange, signal }) {
      launches++;
      assert.deepEqual(payload, { entrypoint: "guard/main.ts", changes: [] });
      // Span a complete lease; the shared worker must renew it while this task runs.
      await delay(1_200, undefined, { signal });
      return await exchange("read", { path: "guard/main.ts", role: "dependency", view: "after" }, signal);
    },
    async cleanup() { cleaned = true; return true; }
  };
  const worker = await startWorker(fixture, handler);
  try {
    await assert.rejects(runScheduledTask({ endpoint: fixture.endpoint, generationId,
      credential: { username: "webhook", password: secret(1) }, taskType: "review-tracing", handlerRevision: revision,
      payload: {}, async exchange() { throw new Error("unauthorized issuer must not receive reads"); } }), /401/);
    const calls: unknown[] = [];
    const result = await runScheduledTask({ endpoint: fixture.endpoint, generationId, credential,
      taskType: "review-tracing", handlerRevision: revision, payload: { entrypoint: "guard/main.ts", changes: [] },
      async exchange(operation, input) {
        calls.push({ operation, input });
        return { content: Buffer.from("export function matches(): boolean { return false; }").toString("base64") };
      } });
    assert.deepEqual(result, { content: Buffer.from("export function matches(): boolean { return false; }").toString("base64") });
    assert.deepEqual(calls, [{ operation: "read", input: { path: "guard/main.ts", role: "dependency", view: "after" } }]);
    assert.equal(launches, 1);
    assert.equal(cleaned, true);
  } finally { try { await worker.close(); } finally { await fixture.close(); } }
});

it("cancels scheduled work and cleans the owned task before reusing capacity", async () => {
  const revision = "f".repeat(64);
  const fixture = await schedulerFixture(revision);
  const stop = new AbortController();
  let started = false, cleaned = false;
  const handler: ExecutionTaskHandler = { taskType: "review-tracing", revision,
    async run({ signal, payload }) {
      if (payload !== null && typeof payload === "object" && Reflect.get(payload, "fast") === true) return true;
      started = true;
      await delay(30_000, undefined, { signal });
      return false;
    },
    async cleanup() { cleaned = true; return true; }
  };
  const worker = await startWorker(fixture, handler);
  try {
    const task = runScheduledTask({ endpoint: fixture.endpoint, generationId, credential, taskType: "review-tracing",
      handlerRevision: revision, payload: {}, async exchange() { throw new Error("unexpected read"); }, signal: stop.signal });
    const rejected = assert.rejects(task, /abort/i);
    await waitFor(() => started);
    stop.abort();
    await rejected;
    await waitFor(() => cleaned);
    const next = await runScheduledTask({ endpoint: fixture.endpoint, generationId, credential, taskType: "review-tracing",
      handlerRevision: revision, payload: { fast: true }, async exchange() { throw new Error("unexpected read"); } });
    assert.equal(next, true);
  } finally { stop.abort(); try { await worker.close(); } finally { await fixture.close(); } }
});

it("keeps repository dependency accounting on the issuer and rejects traversal from a task handler", async () => {
  const revision = "f".repeat(64);
  const fixture = await schedulerFixture(revision);
  const handler: ExecutionTaskHandler = { taskType: "review-tracing", revision,
    async run({ exchange, signal }) {
      await exchange("read", { path: "../operator-secret", role: "dependency", view: "after" }, signal);
      return false;
    }, async cleanup() { return true; } };
  const worker = await startWorker(fixture, handler);
  try {
    const runtime = createScheduledReviewTraceRuntime({ endpoint: fixture.endpoint, generationId, credential, handlerRevision: revision });
    const reads: string[] = [];
    await assert.rejects(runtime.evaluate({ entrypoint: "guard/main.ts", changes: [],
      async readFile(path) { reads.push(path); return Buffer.from("export function matches(): boolean { return false; }"); },
      async readTargetFile(path) { reads.push(path); return undefined; } }), /path|repository/i);
    assert.deepEqual(reads, ["guard/main.ts"]);
  } finally { try { await worker.close(); } finally { await fixture.close(); } }
});

it.skipIf(process.env.DIM_TEST_REVIEW_TRACE_DOCKER !== "1")("runs a TypeScript detector through the HTTP scheduler and installed host handler in real Docker", async () => {
  const recipe = await scheduledRecipe();
  const repository = resolveExamplePath(recipe, "repository");
  const { reviewTracingTaskHandler } = await import("../../../packages/host/plugins/review-tracing-node/src/index.js");
  const fixture = await schedulerFixture(reviewTracingTaskHandler.revision);
  const worker = await startWorker(fixture, reviewTracingTaskHandler);
  try {
    const runtime = createScheduledReviewTraceRuntime({ endpoint: fixture.endpoint, generationId, credential,
      handlerRevision: reviewTracingTaskHandler.revision });
    const files: Readonly<Record<string, string>> = {
      "guard/main.ts": await readFile(join(repository, "guard/main.ts"), "utf8"),
      "guard/helper.ts": await readFile(join(repository, "guard/helper.ts"), "utf8")
    };
    const before = await readFile(join(repository, "app.json"), "utf8");
    const after = before.replace('"enabled"', '"disabled"');
    const change = { status: "M", oldPath: "app.json", newPath: "app.json", oldPathBytes: "", newPathBytes: "",
      oldMode: "100644", newMode: "100644", oldObjectId: "a".repeat(40), newObjectId: "b".repeat(40) };
    const result = await runtime.evaluate({ entrypoint: "guard/main.ts",
      changes: [change],
      async readFile(path) { return files[path] === undefined ? undefined : Buffer.from(files[path]); },
      async readTargetFile(path, view) { assert.equal(path, "app.json"); return Buffer.from(view === "before" ? before : after); } });
    assert.equal(result.matches, true);
    assert.deepEqual(result.manifest.map(({ path, role, view }) => [path, role, view]), [
      ["app.json", "target", "after"], ["app.json", "target", "before"],
      ["guard/helper.ts", "dependency", "after"], ["guard/main.ts", "dependency", "after"]
    ]);
    assert(result.manifest.every(({ digest }) => digest !== null && /^[a-f0-9]{64}$/.test(digest)));
  } finally { try { await worker.close(); } finally { await fixture.close(); } }
});
