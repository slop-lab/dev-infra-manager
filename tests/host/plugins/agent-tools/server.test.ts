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

it("retains explicit OpenCode service intent across boot resume and clears it on stop", async () => {
  const f = await fixture();
  const registry = fileURLToPath(new URL("../../../../packages/host/core/src/workspace-image-assets/dim-workspace.mjs", import.meta.url));
  const serviceFile = path.join(f.home, ".local/state/dim/services/dim-agent-tools-opencode.json");
  const ownerFile = path.join(f.home, ".local/state/dim/services/dim-agent-tools-opencode.lock/owner.json");
  try {
    await writeFile(path.join(f.bin, "dim-workspace"), `#!/bin/sh\nexec '${process.execPath}' '${registry}' "$@"\n`, { mode: 0o700 });
    await mkdir(path.join(f.home, ".config/dim"), { recursive: true });
    await writeFile(path.join(f.home, ".config/dim/workspace.json"), "{}", { mode: 0o600 });
    await writeFile(path.join(f.home, "retained-session.json"), JSON.stringify({ id: "retained-session", directory: f.home }));
    await writeFile(path.join(f.bin, "opencode"), `#!${process.execPath}
// @ts-check
const http=require('node:http'),fs=require('node:fs');
if(process.argv.includes('--version')){console.log('1.18.31');process.exit(0);}
if(process.argv.includes('models')){console.log('openai/test-model\\n{\\n  "id": "test-model"\\n}');process.exit(0);}
fs.writeFileSync(process.env.HOME+'/server-argv.json',JSON.stringify(process.argv));
const auth='Basic '+Buffer.from(process.env.OPENCODE_SERVER_USERNAME+':'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
http.createServer((q,s)=>{s.statusCode=q.headers.authorization===auth?200:401;s.end(s.statusCode===401?'{}':q.url==='/session/retained-session'?fs.readFileSync(process.env.HOME+'/retained-session.json'):JSON.stringify({healthy:true}));}).listen(Number(process.env.OPENCODE_WEB_PORT),'127.0.0.1');
`, { mode: 0o700 });
    Object.assign(f.env, { OPENCODE_WEB_CORS_ORIGINS: '["https://preview.example.test"]' });
    const dormant = path.join(f.home, "unrelated-started");
    await execute(path.join(f.bin, "dim-workspace"), ["service", "register", "--name", "project-other", "--", process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(dormant)},'unexpected')`], { env: f.env });
    const started = await f.run("start");
    await expect(access(dormant)).rejects.toThrow();
    await execute("bash", [path.join(path.dirname(launcher), "opencode-service.bash"), "__resume"], { env: f.env });
    await expect(access(dormant)).rejects.toThrow();
    await execute(path.join(f.bin, "dim-workspace"), ["service", "remove", "project-other"], { env: f.env });
    const password = (await readFile(started.credentialsFile, "utf8")).trim().split("\n")[1]!;
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
    const url = started.url + "/session/retained-session";
    expect(await (await fetch(url, { headers })).json()).toEqual({ id: "retained-session", directory: f.home });
    const registration = JSON.parse(await readFile(serviceFile, "utf8"));
    expect(registration.argv).toEqual(["bash", path.join(path.dirname(launcher), "opencode-service.bash"), "__run"]);
    expect(JSON.stringify(registration)).not.toContain(password);
    await expect(f.setPassword("short")).rejects.toThrow("12–128");
    expect((await f.run("status")).state).toBe("running");
    expect((await fetch(url, { headers })).status).toBe(200);
    const owner = JSON.parse(await readFile(ownerFile, "utf8"));
    const serverPid = Number((await readFile(path.join(path.dirname(started.credentialsFile), "server.pid"), "utf8")).split(" ")[0]);
    expect(serverPid).toBe(owner.child);
    expect((await readFile(`/proc/${serverPid}/status`, "utf8")).match(/^PPid:\s+(\d+)$/m)?.[1]).toBe(String(owner.pid));
    delete (f.env as NodeJS.ProcessEnv).OPENCODE_WEB_CORS_ORIGINS;
    delete (f.env as NodeJS.ProcessEnv).OPENCODE_WEB_PORT;
    // A container boot loses every process, but retains HOME and the registered
    // command. Resume the real boot registry; do not call the OpenCode start API.
    for (const pid of [owner.pid, owner.child, serverPid]) { try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
    await expect.poll(async () => (await f.run("status")).state).toBe("stopped");
    await execute(path.join(f.bin, "dim-workspace"), ["service", "resume"], { env: f.env, timeout: 10_000 });
    await expect.poll(async () => (await f.run("status")).state, { timeout: 15_000 }).toBe("running");
    expect(await readFile(started.credentialsFile, "utf8")).toBe(`opencode\n${password}\n`);
    expect((await fetch(started.url)).status).toBe(401);
    expect(JSON.parse(await readFile(path.join(f.home, "server-argv.json"), "utf8"))).toContain("https://preview.example.test");
    expect(await (await fetch(url, { headers })).json()).toEqual({ id: "retained-session", directory: f.home });
    expect((await f.setPassword("replacement supervised password")).state).toBe("running");
    expect((await fetch(url, { headers })).status).toBe(401);
    const entered = path.join(f.root, "rotation-entered"), release = path.join(f.root, "rotation-release");
    const gate = `: > '${entered}'\nfor i in $(seq 1 500); do test -e '${release}' && break; sleep .02; done\ntest -e '${release}' || exit 77\n`;
    // Gate the old recursive handoff OR the fixed inline registration. Only the
    // latter still owns the control lock, so a later explicit stop must win.
    await writeFile(path.join(f.bin, "bash"), `#!/bin/sh\nif [ "$1" = '${path.join(path.dirname(launcher), "opencode-service.bash")}' ] && [ "$2" = start ]; then\n${gate}fi\nexec /bin/bash "$@"\n`, { mode: 0o700 });
    await writeFile(path.join(f.bin, "dim-workspace"), `#!/bin/sh\nif [ "$1" = service ] && [ "$2" = register ]; then\n${gate}fi\nexec '${process.execPath}' '${registry}' "$@"\n`, { mode: 0o700 });
    const rotation = f.setPassword("serialized password rotation");
    let stopping: ReturnType<typeof f.run> | undefined;
    try {
      await expect.poll(async () => access(entered).then(() => true, () => false), { timeout: 5_000 }).toBe(true);
      await expect(execute("flock", ["--exclusive", "--nonblock", path.join(f.home, ".local/state/dim-agent-tools/opencode-service.lock"), "true"])).rejects.toMatchObject({ code: 1 });
      stopping = f.run("stop");
      await writeFile(release, "release");
      expect((await rotation).state).toBe("running");
      expect((await stopping).state).toBe("stopped");
    } finally {
      await writeFile(release, "release");
      await Promise.allSettled([rotation, ...(stopping ? [stopping] : [])]);
    }
    await expect(access(serviceFile)).rejects.toThrow();
    await execute("bash", [path.join(path.dirname(launcher), "opencode-service.bash"), "__resume"], { env: f.env });
    await expect(access(serviceFile)).rejects.toThrow();
    await execute(path.join(f.bin, "dim-workspace"), ["service", "resume"], { env: f.env, timeout: 10_000 });
    expect((await f.run("status")).state).toBe("stopped");
  } finally { await f.run("stop").catch(() => {}); await rm(f.root, { recursive: true, force: true }); }
}, 40_000);

it("waits for an owned startup holding the launch lock during model discovery", async () => {
  const f = await fixture();
  const registry = fileURLToPath(new URL("../../../../packages/host/core/src/workspace-image-assets/dim-workspace.mjs", import.meta.url));
  const entered = path.join(f.home, "models-entered"), release = path.join(f.home, "models-release");
  let startup: ReturnType<typeof f.run> | undefined;
  try {
    await writeFile(path.join(f.bin, "dim-workspace"), `#!/bin/sh\nexec '${process.execPath}' '${registry}' "$@"\n`, { mode: 0o700 });
    await mkdir(path.join(f.home, ".config/dim"), { recursive: true });
    await writeFile(path.join(f.home, ".config/dim/workspace.json"), "{}", { mode: 0o600 });
    await writeFile(path.join(f.bin, "opencode"), `#!${process.execPath}
// @ts-check
const fs=require('node:fs'),http=require('node:http');
if(process.argv.includes('--version')){console.log('1.18.31');process.exit(0);}
if(process.argv.includes('models')){fs.writeFileSync('${entered}','');const t=setInterval(()=>{if(fs.existsSync('${release}')){clearInterval(t);console.log('openai/test-model\\n{\\n  "id": "test-model"\\n}');}},20);}
else{const auth='Basic '+Buffer.from(process.env.OPENCODE_SERVER_USERNAME+':'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');http.createServer((q,s)=>{s.statusCode=q.headers.authorization===auth?200:401;s.end(JSON.stringify({healthy:true}));}).listen(Number(process.env.OPENCODE_WEB_PORT),'127.0.0.1');}
`, { mode: 0o700 });
    startup = f.run("start");
    // Observe the rejection immediately so the old implementation's real
    // five-second timeout remains evidence rather than an unhandled promise.
    const result = startup.then(value => ({ value }), error => ({ error }));
    await expect.poll(() => access(entered).then(() => true, () => false), { timeout: 5_000 }).toBe(true);
    await expect(execute("bash", [launcher, "__probe", "--json"], { env: f.env })).rejects.toMatchObject({ code: 75, stdout: "", stderr: "" });
    // The kernel lock, not a model response or a successful server probe,
    // controls this boundary. Keep the prelaunch worker blocked past the
    // launcher's existing five-second public lock wait; do not change it.
    await expect(execute("flock", ["--exclusive", "--timeout", "6", path.join(f.home, ".local/state/opencode-web/launch.lock"), "true"])).rejects.toMatchObject({ code: 1 });
    await writeFile(release, "release");
    const outcome = await result;
    if ("error" in outcome) throw outcome.error;
    expect(outcome.value.state).toBe("running");
  } finally {
    await writeFile(release, "release");
    await startup?.catch(() => {});
    await f.run("stop").catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
}, 20_000);

it("does not retry another private startup probe failure as lock contention", async () => {
  const f = await fixture();
  const registry = fileURLToPath(new URL("../../../../packages/host/core/src/workspace-image-assets/dim-workspace.mjs", import.meta.url));
  try {
    await writeFile(path.join(f.bin, "dim-workspace"), `#!/bin/sh\nexec '${process.execPath}' '${registry}' "$@"\n`, { mode: 0o700 });
    await mkdir(path.join(f.home, ".config/dim"), { recursive: true });
    await writeFile(path.join(f.home, ".config/dim/workspace.json"), "{}", { mode: 0o600 });
    await writeFile(path.join(f.bin, "flock"), '#!/bin/sh\nif [ "$1" = --nonblock ]; then echo probe-failed >&2; exit 42; fi\nexec /usr/bin/flock "$@"\n', { mode: 0o700 });
    await mkdir(path.join(f.home, ".local/state/opencode-web"), { recursive: true, mode: 0o700 });
    // A missing OpenCode binary must not hide the earlier distinct probe error.
    await expect(f.run("start")).rejects.toMatchObject({ code: 42, stderr: expect.stringContaining("probe-failed") });
  } finally { await f.run("stop").catch(() => {}); await rm(f.root, { recursive: true, force: true }); }
});

it("fails clearly when DIM guest service helpers are missing instead of starting detached", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.home, ".config/dim"), { recursive: true });
    await writeFile(path.join(f.home, ".config/dim/workspace.json"), "{}");
    await expect(f.run("start")).rejects.toThrow("DIM workspace service registry is unavailable");
    await expect(access(path.join(f.home, ".local/state/opencode-web/credentials"))).rejects.toThrow();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("does not replace or remove a project service occupying the reserved plugin name", async () => {
  const f = await fixture();
  try {
    const registry = fileURLToPath(new URL("../../../../packages/host/core/src/workspace-image-assets/dim-workspace.mjs", import.meta.url));
    await writeFile(path.join(f.bin, "dim-workspace"), `#!/bin/sh\nexec '${process.execPath}' '${registry}' "$@"\n`, { mode: 0o700 });
    await mkdir(path.join(f.home, ".config/dim"), { recursive: true });
    await writeFile(path.join(f.home, ".config/dim/workspace.json"), "{}");
    const service = path.join(f.home, ".local/state/dim/services/dim-agent-tools-opencode.json");
    await mkdir(path.dirname(service), { recursive: true });
    const original = JSON.stringify({ schemaVersion: 1, argv: ["node", "project-service.mjs"], cwd: f.home });
    await writeFile(service, original, { mode: 0o600 });
    for (const operation of ["start", "stop"]) await expect(f.run(operation)).rejects.toThrow("occupied or unsafe");
    expect(await readFile(service, "utf8")).toBe(original);
    await expect(access(path.join(f.home, ".local/state/opencode-web/credentials"))).rejects.toThrow();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
