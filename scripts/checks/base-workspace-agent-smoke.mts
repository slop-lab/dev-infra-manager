#!/usr/bin/env -S tsx
/** Explicit live verification of the compiled CLI and the in-guest capability. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const image = process.argv[2];
if (!image) throw new Error("usage: tsx base-workspace-agent-smoke.mts IMAGE");
const root = await mkdtemp(path.join(tmpdir(), "dim-agent-live-"));
const cli = fileURLToPath(new URL("../../packages/cli/core/dist/cli.js", import.meta.url));
const source = path.join(root, "source"), name = `agent-smoke-${path.basename(root).slice(-6).toLowerCase()}`;
const env = { ...process.env, DIM_STATE_ROOT: path.join(root, "state"), DIM_PLUGIN_HOME: path.join(root, "plugins"), XDG_CONFIG_HOME: path.join(root, "config") };
async function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} ${JSON.stringify(args)}: ${code}: ${stderr}`)));
  });
}
const dim = (...args: string[]) => run(process.execPath, [cli, "--host", "local", ...args]);
const exec = (...args: string[]) => dim("exec", name, "--", ...args);
async function waitForCount(count: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const actual = Number(await exec("sh", "-c", "wc -l < /home/dim/agent-resumed.txt"));
      if (actual >= count) return;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`session did not resume ${count} times`, { cause: last });
}
try {
  await mkdir(source);
  await run("git", ["init", "--initial-branch=main", source]);
  await writeFile(path.join(source, "hello.txt"), "ordinary repository\n");
  await run("git", ["-C", source, "add", "."]);
  await run("git", ["-C", source, "-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "source"]);
  const created: unknown = JSON.parse(await dim("create", source, name, "--image", image, "--cpus", "1.5", "--memory", "2g", "--pids", "512", "--json"));
  assert.ok(created && typeof created === "object" && "id" in created);
  assert.deepEqual(JSON.parse(await exec("dim-workspace", "resources", "--json")), { cpuCount: "1.5", memory: "2g", pidsLimit: "512" });
  assert.equal(await exec("dim-nproc"), "1");
  await exec("sh", "-c", "printf retained > local.txt; printf tmp-retained > \"$TMPDIR/agent.txt\"");
  await exec("dim-workspace", "session", "register", "--", "sh", "-c", "printf 'resumed\\n' >> /home/dim/agent-resumed.txt");
  assert.match(await exec("dim-workspace", "restart"), /accepted/);
  await waitForCount(1);
  assert.equal(await exec("cat", "local.txt"), "retained");
  assert.match(await exec("dim-workspace", "recreate"), /accepted/);
  await waitForCount(2);
  assert.equal(await exec("cat", "/mnt/dim-tmp/agent.txt"), "tmp-retained");
  assert.equal(await exec("cat", "hello.txt"), "ordinary repository");
  const guest: unknown = JSON.parse(await exec("cat", "/home/dim/.config/dim/workspace.json"));
  assert.ok(guest && typeof guest === "object");
  assert.deepEqual(Object.keys(guest).sort(), ["endpoint", "token", "workspaceId"]);
  const current: unknown = JSON.parse(await dim("show", name, "--json"));
  assert.ok(current && typeof current === "object" && "id" in current);
  assert.equal(current.id, created.id);
  console.log("compiled CLI: guest allocation/nproc, scoped self restart/recreate and continued session: passed");
} catch (error) {
  const agents = path.join(root, "state", "agents");
  console.error(`Scoped bridge diagnostics remain at ${agents} until cleanup`);
  throw error;
} finally {
  await dim("discard", name, "--yes").catch((error: unknown) => { console.error(error); });
  // The bridge observes discard and exits before its private state is removed.
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  await rm(root, { recursive: true, force: true });
}
