import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { createNodeReviewTraceRuntime } from "../../../packages/control-plane/plugins/review-tracing-node/src/runtime.js";

const enabled = process.env.DIM_TEST_REVIEW_TRACE_DOCKER === "1";
describe.skipIf(!enabled)("brokered Node review tracing in Docker", () => {
  it("tracks module imports and configuration while keeping before/after detector input distinct", async () => {
    const runtime = await createNodeReviewTraceRuntime();
    const files: Readonly<Record<string, string>> = {
      "guard/main.mjs": `import {readTarget} from 'dim:review';import {enabled} from './helper.mjs';import config from './config.json' with {type:'json'};export async function matches(changes){const extra=await import('./dynamic.mjs');const before=JSON.parse(await readTarget('app.json','before'));const after=JSON.parse(await readTarget('app.json'));return enabled&&config.field==='security'&&extra.ok&&before.security!==after.security&&changes.length===1;}`,
      "guard/helper.mjs": `import {readText} from 'dim:review';export const enabled=(await readText('guard/settings.txt'))==='enabled';`,
      "guard/config.json": '{"field":"security"}',
      "guard/dynamic.mjs": "export const ok=true;",
      "guard/settings.txt": "enabled"
    };
    const result = await runtime.evaluate({
      entrypoint: "guard/main.mjs",
      changes: [{ status: "M", oldPath: "app.json", newPath: "app.json", oldPathBytes: "", newPathBytes: "" }],
      async readFile(path) { return files[path] === undefined ? undefined : Buffer.from(files[path]); },
      async readTargetFile(path, view) { assert.equal(path, "app.json"); return Buffer.from(JSON.stringify({ security: view === "before" ? "old" : "new" })); }
    });
    assert.equal(result.matches, true);
    assert.deepEqual(result.manifest.filter(({ role }) => role === "dependency").map(({ path }) => path).sort(), Object.keys(files).sort());
    assert.deepEqual(result.manifest.filter(({ role }) => role === "target").map(({ path, view }) => [path, view]).sort(), [["app.json", "after"], ["app.json", "before"]]);
    assert(result.manifest.every(({ digest }) => digest !== null && /^[a-f0-9]{64}$/.test(digest)));
    assert.match(runtime.revision, /^[a-f0-9]{64}$/);
  });

  it("records missing target files and does not downgrade the entrypoint read", async () => {
    const runtime = await createNodeReviewTraceRuntime();
    const source = `import {readTarget} from 'dim:review';export async function matches(){return await readTarget('missing.json')===undefined&&(await readTarget('guard.mjs')).includes('matches');}`;
    const result = await runtime.evaluate({ entrypoint: "guard.mjs", changes: [], async readFile() { return Buffer.from(source); }, async readTargetFile(path) { return path === "guard.mjs" ? Buffer.from(source) : undefined; } });
    assert.equal(result.matches, true);
    assert(result.manifest.some(({ path, role }) => path === "guard.mjs" && role === "dependency"));
    assert(result.manifest.some(({ path, role, digest }) => path === "missing.json" && role === "target" && digest === null));
  });

  it("denies built-in imports, repository traversal and non-boolean results", async () => {
    const runtime = await createNodeReviewTraceRuntime();
    for (const source of [
      "import fs from 'node:fs';export function matches(){return false;}",
      "import {readTarget} from 'dim:review';export async function matches(){await readTarget('../outside');return false;}",
      "export function matches(){return 'yes';}"
    ]) {
      const reads: string[] = [];
      await assert.rejects(runtime.evaluate({ entrypoint: "guard.mjs", changes: [], async readFile(path) { reads.push(path); return Buffer.from(source); }, async readTargetFile(path) { reads.push(path); return undefined; } }));
      assert(reads.every((path) => path === "guard.mjs"));
    }
  });

  it("does not expose foreign process constructors through API, JSON or change metadata", async () => {
    const runtime = await createNodeReviewTraceRuntime();
    const source = `import {readTarget} from 'dim:review';import config from './config.json' with {type:'json'};export function matches(changes){for(const fn of [readTarget.constructor,config.constructor.constructor,changes.constructor.constructor]){try{fn('return process')();return false;}catch{}}return typeof process==='undefined';}`;
    const result = await runtime.evaluate({ entrypoint: "guard.mjs", changes: [], async readFile(path) { return Buffer.from(path === "config.json" ? "{}" : source); }, async readTargetFile() { return undefined; } });
    assert.equal(result.matches, true);
  });

  it("aborts a non-terminating detector and removes its owned container", async () => {
    const runtime = await createNodeReviewTraceRuntime();
    const controller = new AbortController();
    const pending = runtime.evaluate({ entrypoint: "guard.mjs", changes: [], async readFile() { return Buffer.from("export function matches(){while(true){}}"); }, async readTargetFile() { return undefined; }, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 750);
    try { await assert.rejects(pending, /abort/); }
    finally { clearTimeout(timer); }
  });

  it("recovers and removes a container when create succeeds but the CLI loses its returned identity", async () => {
    const actualDocker = execFileSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).trim();
    const directory = await mkdtemp(join(tmpdir(), "dim-trace-lost-create-"));
    const identityFile = join(directory, "created-id");
    const originalPath = process.env.PATH;
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    let createdId: string | undefined;
    try {
      // The real daemon creates the container. This shim simulates a client
      // failure after that side effect, without handing the runtime its ID.
      await writeFile(join(directory, "docker"), `#!/bin/sh\nif [ "$1" = create ]; then\n  ${quote(actualDocker)} "$@" > ${quote(identityFile)} || exit "$?"\n  exit 17\nfi\nexec ${quote(actualDocker)} "$@"\n`, { mode: 0o700 });
      process.env.PATH = `${directory}:${originalPath ?? ""}`;
      const runtime = await createNodeReviewTraceRuntime();
      await assert.rejects(runtime.evaluate({ entrypoint: "guard.mjs", changes: [], async readFile() { return Buffer.from("export function matches(){return false;}"); }, async readTargetFile() { return undefined; } }), /Docker command failed \(17\)/);
      createdId = (await readFile(identityFile, "utf8")).trim();
      assert.match(createdId, /^[a-f0-9]{64}$/);
      assert.throws(() => execFileSync(actualDocker, ["container", "inspect", createdId!], { stdio: "pipe" }), /No such (object|container)/i);
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (createdId === undefined) { try { createdId = (await readFile(identityFile, "utf8")).trim(); } catch { /* create may not have reached the daemon */ } }
      if (createdId !== undefined && /^[a-f0-9]{64}$/.test(createdId)) { try { execFileSync(actualDocker, ["rm", "--force", createdId], { stdio: "pipe" }); } catch { /* runtime already removed its exact container */ } }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
