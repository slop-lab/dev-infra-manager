import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const vitest = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));
const vitestReporter = fileURLToPath(new URL("../../support/failure-only-reporter.ts", import.meta.url));
const nodeReporter = fileURLToPath(new URL("../../support/node-failure-reporter.ts", import.meta.url));
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-reporting-")); roots.push(root); return root;
}
async function run(args: string[], cwd: string, verbose = false): Promise<{ code: number; output: string }> {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, FORCE_COLOR: undefined,
    NO_COLOR: "1", DIM_CHECK_VERBOSE: verbose ? "1" : undefined }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try { return await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", (code) => resolve({ code: code ?? 128, output }));
  }); } finally { clearTimeout(timer); }
}
async function vitestProbe(source: string | undefined, verbose = false) {
  const root = await fixture();
  await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(root, "node_modules"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "vitest.config.mts"), `import {FailureOnlyReporter} from ${JSON.stringify(vitestReporter)};
export default {test:{root:${JSON.stringify(root)},include:['*.test.ts'],maxWorkers:1,
reporters:process.env.DIM_CHECK_VERBOSE==='1'?['default']:[new FailureOnlyReporter()],
silent:process.env.DIM_CHECK_VERBOSE==='1'?false:'passed-only'}};`);
  if (source !== undefined) await writeFile(join(root, "reporter-probe.test.ts"), source);
  return run([vitest, "run", "--config", join(root, "vitest.config.mts")], root, verbose);
}
it("Vitest hides passing rows/logs while retaining native assertion diffs, failed console and final counts", async () => {
  const source = `import {it,expect} from 'vitest';
it('PASS_ROW_MARKER',()=>console.log('PASS_CONSOLE_MARKER'));
it.skip('SKIP_ROW_MARKER',()=>{});









it('FAIL_ROW_MARKER',()=>{console.error('FAILED_CONSOLE_MARKER');expect({value:1}).toEqual({value:2})});`;
  const quiet = await vitestProbe(source);
  expect(quiet.code).toBe(1); expect(quiet.output).not.toContain("\u001b");
  expect(quiet.output).not.toContain("PASS_ROW_MARKER"); expect(quiet.output).not.toContain("PASS_CONSOLE_MARKER");
  expect(quiet.output).not.toContain("SKIP_ROW_MARKER");
  for (const marker of ["FAIL_ROW_MARKER", "FAILED_CONSOLE_MARKER", "AssertionError", "reporter-probe.test.ts", "Expected", "Received", "1 skipped"]) expect(quiet.output).toContain(marker);
  const verbose = await vitestProbe(source, true);
  expect(verbose.code).toBe(1); expect(verbose.output).toContain("PASS_ROW_MARKER"); expect(verbose.output).toContain("PASS_CONSOLE_MARKER");
});
it("Vitest retains collection failure, unhandled crashes and no-tests diagnostics", async () => {
  const collection = await vitestProbe("console.error('COLLECTION_CONSOLE_MARKER');throw new Error('COLLECTION_ERROR_MARKER')");
  expect(collection.code).toBe(1); expect(collection.output).toContain("COLLECTION_CONSOLE_MARKER"); expect(collection.output).toContain("COLLECTION_ERROR_MARKER");
  const crash = await vitestProbe(`import {it} from 'vitest';it('temporary success',async()=>{setTimeout(()=>{throw new Error('UNHANDLED_CRASH_MARKER')},0);await new Promise(r=>setTimeout(r,20))});`);
  expect(crash.code).toBe(1); expect(crash.output).toContain("UNHANDLED_CRASH_MARKER"); expect(crash.output).toContain("Unhandled");
  const empty = await vitestProbe(undefined);
  expect(empty.code).toBe(1); expect(empty.output).toContain("No test files found");
});
it("Node retains native failure diffs, unattributed process output and summary without passing rows", async () => {
  const root = await fixture(); const file = join(root, "node-probe.mjs");
  await writeFile(file, `import test from 'node:test';import assert from 'node:assert/strict';
test('PASS_ROW_MARKER',()=>console.log('UNATTRIBUTED_OUTPUT_MARKER'));
test.skip('SKIP_ROW_MARKER',()=>{});
test('FAIL_ROW_MARKER',()=>assert.deepEqual({value:1},{value:2}));`);
  const args = ["--import", tsxLoader, "--test", `--test-reporter=${nodeReporter}`, file];
  const quiet = await run(args, root);
  expect(quiet.code).toBe(1); expect(quiet.output).not.toContain("PASS_ROW_MARKER"); expect(quiet.output).not.toContain("SKIP_ROW_MARKER");
  for (const marker of ["UNATTRIBUTED_OUTPUT_MARKER", "FAIL_ROW_MARKER", "AssertionError", "actual", "expected", "node-probe.mjs", "skipped 1"]) expect(quiet.output).toContain(marker);
  const verbose = await run(args, root, true);
  expect(verbose.code).toBe(1); expect(verbose.output).toContain("PASS_ROW_MARKER");
});
it("Node preserves stderr and a module startup crash before any passing test", async () => {
  const root = await fixture(); const file = join(root, "node-crash.mjs");
  await writeFile(file, "console.error('EARLY_STDERR_MARKER');throw new Error('NODE_STARTUP_CRASH_MARKER')");
  const result = await run(["--import", tsxLoader, "--test", `--test-reporter=${nodeReporter}`, file], root);
  expect(result.code).toBe(1); expect(result.output).toContain("EARLY_STDERR_MARKER"); expect(result.output).toContain("NODE_STARTUP_CRASH_MARKER"); expect(result.output).toContain("fail 1");
});
