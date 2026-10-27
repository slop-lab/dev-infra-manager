import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL("../../../../packages/host/plugins/agent-tools/src/assets/opencode-server.bash", import.meta.url));
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dim-server-lifecycle-"));
  const home = path.join(root, "home"), bin = path.join(root, "bin");
  await mkdir(home); await mkdir(bin);
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  const address = probe.address(); if (!address || typeof address === "string") throw Error("missing probe address");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, ".local/state"), PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, OPENCODE_WEB_PORT: String(port), NPM_CONFIG_CACHE: undefined, npm_config_cache: undefined };
  const run = async (operation: string, cwd?: string) => JSON.parse((await execute("bash", [launcher, operation, "--json"], { env, timeout: 30_000, ...(cwd ? { cwd } : {}) })).stdout) as { state: string; port: number; credentialsFile: string; logFile: string; username: string; url: string };
  const setPassword = async (password: string) => new Promise<{ state: string }>((resolve, reject) => {
    const child = spawn("bash", [launcher, "password", "--json"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", code => { if (code !== 0) reject(Error(stderr)); else resolve(JSON.parse(stdout)); });
    child.stdin.end(JSON.stringify({ password }));
  });
  return { root, home, bin, port, env, run, setPassword };
}

it("inspects an unconfigured guest without installing tools, evaluating hooks, or creating state", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.home, ".config/dim"), { recursive: true });
    await writeFile(path.join(f.home, ".config/dim/opencode-launch.js"), 'throw Error("must not run")');
    for (const operation of ["status", "stop"]) {
      expect(await f.run(operation)).toEqual({ state: "stopped", port: f.port, url: `http://127.0.0.1:${f.port}`, username: "opencode", credentialsFile: path.join(f.home, ".local/state/opencode-web/credentials"), logFile: path.join(f.home, ".local/state/opencode-web/server.log") });
    }
    expect(await readdir(f.home)).toEqual([".config"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("starts an authenticated owned listener, reports safely, and stops only that instance", async () => {
  const f = await fixture();
  try {
    const fake = path.join(f.bin, "opencode");
    await writeFile(fake, `#!${process.execPath}
// @ts-check
const http = require('node:http');
if (process.argv.includes('--version')) { console.log('1.18.31'); process.exit(0); }
if (process.argv.includes('models')) { console.log('openai/test-model\\n{\\n  \"id\": \"test-model\"\\n}'); process.exit(0); }
const expected = 'Basic ' + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ':' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
http.createServer((req, res) => { res.statusCode = req.headers.authorization === expected ? 200 : 401; res.end(JSON.stringify({healthy: res.statusCode === 200})); }).listen(Number(process.env.OPENCODE_WEB_PORT), '127.0.0.1');
`);
    await chmod(fake, 0o700);
    const started = await f.run("start");
    expect(started.state).toBe("running");
    const credential = await readFile(started.credentialsFile, "utf8");
    expect(JSON.stringify(started)).not.toContain(credential.trim().split("\n")[1]);
    expect(await f.run("status")).toEqual(started);
    const pidFile = path.join(path.dirname(started.credentialsFile), "server.pid");
    const firstPid = (await readFile(pidFile, "utf8")).split(" ")[0];
    expect((await f.run("start", f.home)).state).toBe("running");
    expect((await readFile(pidFile, "utf8")).split(" ")[0]).not.toBe(firstPid);
    expect(await readFile(started.credentialsFile, "utf8")).toBe(credential);
    const password = 'quotes" backslash\\ spaces : secure  ';
    expect((await f.setPassword(password)).state).toBe("running");
    const credentials = await f.run("credentials") as unknown as { username: string; password: string };
    expect(credentials).toEqual({ username: "opencode", password });
    const authentication = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    expect((await fetch(`http://127.0.0.1:${f.port}/global/health`, { headers: { authorization: authentication } })).status).toBe(200);
    const oldAuthentication = `Basic ${Buffer.from(credential.trim().split("\n").join(":")).toString("base64")}`;
    expect((await fetch(`http://127.0.0.1:${f.port}/global/health`, { headers: { authorization: oldAuthentication } })).status).toBe(401);
    expect(JSON.stringify(await f.run("status"))).not.toContain(password);
    expect(await readFile(started.logFile, "utf8")).not.toContain(password);
    await rm(fake);
    expect((await f.run("status")).state).toBe("running");
    expect((await f.run("stop")).state).toBe("stopped");
    expect((await f.run("status")).state).toBe("stopped");
    expect(await readFile(started.credentialsFile, "utf8")).toBe(`opencode\n${password}\n`);
    await expect(access(path.join(path.dirname(started.credentialsFile), "server.pid"))).rejects.toThrow();
  } finally { await f.run("stop").catch(() => {}); await rm(f.root, { recursive: true, force: true }); }
}, 40_000);

it("never signals an unrelated listener even when a PID record points at it", async () => {
  const f = await fixture();
  const child = spawn(process.execPath, ["-e", `require('node:http').createServer((q,s)=>s.end('{}')).listen(${f.port},'127.0.0.1',()=>console.log('ready'))`], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DIM_OPENCODE_WEB_INSTANCE_ID: "a".repeat(64) } });
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
    const state = path.join(f.home, ".local/state/opencode-web");
    await mkdir(state, { recursive: true });
    const source = await readFile(`/proc/${child.pid}/stat`, "utf8");
    const start = source.slice(source.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
    await writeFile(path.join(state, "server.pid"), `${child.pid} ${start} ${f.port} ${"b".repeat(64)}\n`);
    expect((await f.run("status")).state).toBe("stopped");
    expect((await f.run("stop")).state).toBe("stopped");
    await writeFile(path.join(state, "server.pid"), `${child.pid} ${Number(start) + 1} ${f.port} ${"a".repeat(64)}\n`);
    expect((await f.run("stop")).state).toBe("stopped");
    expect((await f.setPassword("do not signal unrelated processes")).state).toBe("stopped");
    expect(child.exitCode).toBeNull();
    expect(process.kill(child.pid!, 0)).toBe(true);
  } finally { child.kill(); await rm(f.root, { recursive: true, force: true }); }
});

it("sets a password before installation without launching tools and rejects unsafe input", async () => {
  const f = await fixture();
  try {
    expect((await f.setPassword("configured before installation")).state).toBe("stopped");
    expect(await f.run("credentials")).toEqual({ username: "opencode", password: "configured before installation" });
    for (const password of ["short", "x".repeat(129), "a secure password\nnewline", "unicode password é"]) {
      await expect(f.setPassword(password)).rejects.toThrow("12–128");
    }
    expect(await f.run("credentials")).toEqual({ username: "opencode", password: "configured before installation" });
    expect((await f.run("status")).state).toBe("stopped");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
