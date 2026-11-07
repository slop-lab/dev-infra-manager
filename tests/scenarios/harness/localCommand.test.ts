import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { createCommand, createInstallCommand } from "../../../scripts/local-uninstall/command.ts";
import { captureCommandProcess, terminateCommandTree } from "../../../scripts/local-uninstall/command-process.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function childFixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-local-command-")); roots.push(root);
  const pidFile = join(root, "descendant.pid"), script = join(root, "parent.mjs");
  await writeFile(script, `import {spawn} from "node:child_process"; import {writeFileSync} from "node:fs";
    process.on("SIGTERM",()=>{});
    const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{detached:true,stdio:["ignore","pipe","ignore"]});
    child.stdout.once("data",()=>writeFileSync(${JSON.stringify(pidFile)},String(child.pid)));
    setInterval(()=>{},1000);\n`);
  return { pidFile, script };
}
async function live(pid: number, readStat: (path: string) => Promise<string> = path => readFile(path, "utf8")): Promise<boolean> {
  try { const stat = await readStat(`/proc/${pid}/stat`); return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!); }
  catch (error) { if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return false; throw error; }
}
it("recognizes a process disappearing during its proc read without hiding other inspection failures", async () => {
  for (const code of ["ENOENT", "ESRCH"]) {
    await expect(live(123, async path => {
      expect(path).toBe("/proc/123/stat"); throw Object.assign(new Error("process disappeared"), { code });
    })).resolves.toBe(false);
  }
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  await expect(live(123, async () => { throw denied; })).rejects.toBe(denied);
});
async function ready(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 300; attempt++) {
    try { return Number(await readFile(pidFile, "utf8")); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await delay(10);
  }
  throw new Error("command fixture did not start");
}

it("kills an installer's detached descendants before reporting its timeout", async () => {
  const fixture = await childFixture();
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    const run = createCommand(process.env, { timeoutMilliseconds: 3_000, terminationGraceMilliseconds: 100 });
    await expect(run(process.execPath, [fixture.script])).rejects.toThrow("operation timed out");
    expect(await live(Number(await readFile(fixture.pidFile, "utf8")))).toBe(false);
    expect(unrelated.pid).toBeDefined();
    expect(await live(unrelated.pid!)).toBe(true);
  } finally {
    const closed = new Promise<void>((resolve) => unrelated.once("close", () => resolve()));
    unrelated.kill("SIGKILL"); await closed;
  }
});
it("cancels a live command and its detached descendants using its abort signal", async () => {
  const fixture = await childFixture(), cancellation = new AbortController();
  const run = createCommand(process.env, { timeoutMilliseconds: 10_000, terminationGraceMilliseconds: 100, signal: cancellation.signal });
  const pending = run(process.execPath, [fixture.script]);
  const rejected = expect(pending).rejects.toThrow("operation cancelled");
  const pid = await ready(fixture.pidFile);
  cancellation.abort();
  await rejected;
  expect(await live(pid)).toBe(false);
});
it("cleans detached installer children when its owning helper receives SIGTERM", async () => {
  const fixture = await childFixture(), launcher = join(fixture.script, "..", "helper.mjs");
  const owner = pathToFileURL(resolve(import.meta.dirname, "../../../scripts/local-uninstall/command.ts")).href;
  await writeFile(launcher, `import {createCommand} from ${JSON.stringify(owner)}; await createCommand(process.env, {timeoutMilliseconds:10000, terminationGraceMilliseconds:100})(process.execPath, [${JSON.stringify(fixture.script)}]);\n`);
  const helper = spawn(process.execPath, [launcher], { stdio: "ignore" });
  const closed = new Promise<number | null>((resolve) => helper.once("close", resolve));
  try {
    const pid = await ready(fixture.pidFile);
    helper.kill("SIGTERM");
    expect(await closed).not.toBe(0);
    expect(await live(pid)).toBe(false);
  } finally { helper.kill("SIGTERM"); await closed; }
});
it("returns ordinary command output and rejects unavailable commands", async () => {
  const run = createCommand(process.env, { timeoutMilliseconds: 1_000 });
  await expect(run(process.execPath, ["-e", "process.stdout.write('ok')"])).resolves.toEqual({ status: 0, stdout: "ok", stderr: "" });
  await expect(run("/nonexistent/dim-fixture-command", [])).rejects.toMatchObject({ code: "ENOENT" });
});
it("prefers cached metadata only in install children while honoring an explicit operator setting", async () => {
  const env = { ...process.env }; delete env.npm_config_prefer_offline;
  const args = ["-e", "process.stdout.write(process.env.npm_config_prefer_offline ?? 'unset')"];
  expect((await createInstallCommand(env)(process.execPath, args)).stdout).toBe("true");
  expect(env.npm_config_prefer_offline).toBeUndefined();
  expect((await createInstallCommand({ ...env, npm_config_prefer_offline: "false" })(process.execPath, args)).stdout).toBe("false");
  expect((await createInstallCommand({ ...env, NPM_CONFIG_PREFER_OFFLINE: "false" })(process.execPath, args)).stdout).toBe("false");
});

it("never signals an unrelated live PID when the original captured start proof differs", async () => {
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
  const proof = captureCommandProcess(unrelated.pid);
  if (proof === undefined) throw new Error("unrelated fixture identity missing");
  try {
    await expect(terminateCommandTree({ pid: proof.pid, start: proof.start + "0" }, 100)).rejects.toThrow("original command leader exited or changed");
    expect(await live(proof.pid)).toBe(true);
  } finally { await terminateCommandTree(proof, 100); }
});
it("rejects within its budget and closes pipes after the original parent exits with held stdio", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-exited-command-")); roots.push(root);
  const pidFile = join(root, "holder.pid"), parent = join(root, "parent.mjs"), helperFile = join(root, "helper.mjs");
  const holder = `import {writeFileSync} from "node:fs";process.on("SIGTERM",()=>{});writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  await writeFile(parent, `import {spawn} from "node:child_process";const child=spawn(process.execPath,["--input-type=module","-e",${JSON.stringify(holder)}],{detached:true,stdio:["ignore","inherit","inherit"]});child.unref();setTimeout(()=>process.exit(0),50);\n`);
  const owner = pathToFileURL(resolve(import.meta.dirname, "../../../scripts/local-uninstall/command.ts")).href;
  await writeFile(helperFile, `import {createCommand} from ${JSON.stringify(owner)};try{await createCommand(process.env,{timeoutMilliseconds:1500,terminationGraceMilliseconds:100})(process.execPath,[${JSON.stringify(parent)}]);process.exitCode=2;}catch(error){process.stdout.write(error.message);}\n`);
  const helper = spawn(process.execPath, [helperFile], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  helper.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  const closed = new Promise<number | null>((resolve) => helper.once("close", resolve));
  const pid = await ready(pidFile), proof = captureCommandProcess(pid);
  if (proof === undefined) throw new Error("stdio holder proof missing");
  try {
    const code = await Promise.race([closed, delay(4_000).then(() => { throw new Error("helper remained alive on held stdio"); })]);
    expect(code).toBe(0);
    expect(output).toContain("descendant cleanup unconfirmed");
    expect(await live(pid)).toBe(true); // No unsafe attempt to rediscover a reparented holder.
  } finally {
    await terminateCommandTree(proof, 100);
    helper.kill("SIGTERM");
    await closed;
  }
});
it("reports incomplete discovery at the process bound while stopping only verified fixtures", async () => {
  const fixture = await childFixture();
  const parent = spawn(process.execPath, [fixture.script], { stdio: "ignore", detached: true });
  const proof = captureCommandProcess(parent.pid);
  if (proof === undefined) throw new Error("parent proof missing");
  const closed = new Promise<void>((resolve) => parent.once("close", () => resolve()));
  const pid = await ready(fixture.pidFile), childProof = captureCommandProcess(pid);
  try {
    await expect(terminateCommandTree(proof, 100, { maximumProcesses: 1 })).rejects.toThrow("discovery was incomplete");
    expect(await live(pid)).toBe(false);
  } finally {
    if (childProof !== undefined && await live(pid)) await terminateCommandTree(childProof, 100);
    if (await live(proof.pid)) await terminateCommandTree(proof, 100);
    await closed;
  }
});
