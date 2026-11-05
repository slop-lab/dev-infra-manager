import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { createCommand, createInstallCommand } from "../../../scripts/local-uninstall/command.ts";

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
async function live(pid: number): Promise<boolean> {
  try { const stat = await readFile(`/proc/${pid}/stat`, "utf8"); return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}
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
