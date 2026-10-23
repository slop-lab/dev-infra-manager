import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const client = fileURLToPath(new URL("../../../packages/host/core/src/workspace-image-assets/dim-workspace.mjs", import.meta.url));

it("guest commands use only scoped routes, preserve resource allocation and reject host selectors", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "dim-guest-client-"));
  const requests: { method: string; url: string; body: unknown }[] = [];
  let cpuCount = "2.5";
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer scoped-guest-token") { response.writeHead(401).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    requests.push({ method: request.method ?? "", url: request.url ?? "", body });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/v1/resources" ? { cpuCount, memory: "4g", pidsLimit: "512" }
      : request.url === "/v1/plugins" ? { plugins: [] } : { accepted: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing gateway port");
    const configuration = path.join(home, ".config/dim/workspace.json");
    await mkdir(path.dirname(configuration), { recursive: true });
    await writeFile(configuration, JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}`, token: "scoped-guest-token", workspaceId: "owned" }), { mode: 0o600 });
    const run = (...args: string[]) => execute(process.execPath, [client, ...args], { env: { ...process.env, HOME: home } });
    expect(JSON.parse((await run("resources", "--json")).stdout)).toEqual({ cpuCount: "2.5", memory: "4g", pidsLimit: "512" });
    expect((await run("nproc")).stdout.trim()).toBe("2");
    cpuCount = "unlimited";
    expect(Number((await run("nproc")).stdout)).toBeGreaterThanOrEqual(1);
    await run("restart"); await run("recreate");
    await run("plugin", "example", "submit", JSON.stringify({ arbitrary: ["plugin-owned", 123] }));
    await run("plugins");
    expect(requests.slice(-4)).toEqual([
      { method: "POST", url: "/v1/restart", body: {} }, { method: "POST", url: "/v1/recreate", body: {} },
      { method: "POST", url: "/v1/plugins/example/submit", body: { arbitrary: ["plugin-owned", 123] } },
      { method: "GET", url: "/v1/plugins", body: null }
    ]);
    const count = requests.length;
    await expect(run("restart", "--workspace", "other")).rejects.toThrow();
    await expect(run("expose", "--name", "x", "--port", "4096", "--ingress", "https")).rejects.toThrow();
    await expect(run("plugin", "../foreign", "run")).rejects.toThrow();
    await expect(run("plugin", "example", "submit", "not-json")).rejects.toThrow();
    await chmod(configuration, 0o644);
    await expect(run("resources")).rejects.toThrow(/private user-owned/);
    expect(requests).toHaveLength(count);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});

it("local session registration preserves exact argv and cwd and resumes after another process starts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "dim-guest-session-"));
  try {
    const run = (...args: string[]) => execute(process.execPath, [client, ...args], { cwd: home, env: { ...process.env, HOME: home } });
    await run("session", "resume"); // A fresh workspace has nothing to continue.
    const marker = path.join(home, "continued.json");
    const program = `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))`;
    const literal = "value;$(no-shell) --host";
    await run("session", "register", "--", process.execPath, "-e", program, marker, literal);
    const saved = JSON.parse(await readFile(path.join(home, ".local/state/dim/session.json"), "utf8"));
    expect(saved.argv).toEqual([process.execPath, "-e", program, marker, literal]);
    await run("session", "resume");
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ cwd: home, args: [literal] });
    await rm(marker); await run("session", "resume");
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ cwd: home, args: [literal] });
    await run("session", "clear"); await run("session", "resume");
    await expect(readFile(path.join(home, ".local/state/dim/session.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("registered services resume independently of sessions without duplicate processes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "dim-guest-services-"));
  const run = (...args: string[]) => execute(process.execPath, [client, ...args], { cwd: home, env: { ...process.env, HOME: home } });
  try {
    const marker = path.join(home, "starts");
    await run("session", "register", "--", "coding-agent", "resume");
    await run("service", "register", "--name", "tunnel", "--", process.execPath, "-e", `require('node:fs').appendFileSync(process.argv[1],process.pid+'\\n');setInterval(()=>{},1000)`, marker);
    await Promise.all([run("service", "resume"), run("service", "resume")]);
    await expect.poll(async () => (await readFile(marker, "utf8")).trim().split("\n").length).toBe(1);
    await run("service", "resume");
    expect(JSON.parse((await run("service", "list")).stdout)).toEqual([{ name: "tunnel", running: true }]);
    expect((await readFile(marker, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(home, ".local/state/dim/session.json"), "utf8")).argv).toEqual(["coding-agent", "resume"]);
    await run("service", "remove", "tunnel");
    expect(JSON.parse((await run("service", "list")).stdout)).toEqual([]);
    await run("service", "register", "--name", "oneshot", "--", process.execPath, "-e", "process.exit(0)");
    await run("service", "resume");
    await expect.poll(async () => JSON.parse((await run("service", "list")).stdout)).toEqual([{ name: "oneshot", running: false }]);
    await expect(run("service", "register", "--name", "../escape", "--", "true")).rejects.toThrow();
  } finally { await run("service", "remove", "tunnel").catch(() => {}); await rm(home, { recursive: true, force: true }); }
});

it("parallel service resumes retain one kernel guard across stale metadata recovery and restarts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "dim-guest-services-race-"));
  const run = (...args: string[]) => execute(process.execPath, [client, ...args], { cwd: home, env: { ...process.env, HOME: home } });
  const root = path.join(home, ".local/state/dim/services");
  const guard = path.join(root, "worker.lock.guard");
  const marker = path.join(home, "starts");
  try {
    await run("service", "register", "--name", "worker", "--", process.execPath, "-e",
      "require('node:fs').appendFileSync(process.argv[1], JSON.stringify(process.pid)+'\\n');setInterval(()=>{},1000)", marker);
    // A dead supervisor may leave metadata behind. Contenders must not unlink a
    // replacement owner's lock while recovering the previous registration.
    await mkdir(path.join(root, "worker.lock"));
    await writeFile(path.join(root, "worker.lock/owner.json"), JSON.stringify({
      pid: process.pid, ticks: "obsolete", boot: "previous-boot", nonce: "dead", child: 0, childTicks: ""
    }), { mode: 0o600 });
    let inode: number | undefined;
    for (let round = 1; round <= 3; round++) {
      await Promise.all(Array.from({ length: 12 }, () => run("service", "resume")));
      await expect.poll(async () => (await readFile(marker, "utf8")).trim().split("\n").length).toBe(round);
      expect(JSON.parse((await run("service", "list")).stdout)).toEqual([{ name: "worker", running: true }]);
      // This is the synchronization invariant, independent of process scheduling:
      // the running supervisor owns the same kernel lock used by every contender.
      await expect(execute("flock", ["--nonblock", guard, "true"])).rejects.toMatchObject({ code: 1 });
      const current = await stat(guard);
      if (inode !== undefined) expect(current.ino).toBe(inode);
      inode = current.ino;
      await run("service", "remove", "worker");
      expect((await stat(guard)).ino).toBe(inode);
      await run("service", "register", "--name", "worker", "--", process.execPath, "-e",
        "require('node:fs').appendFileSync(process.argv[1], JSON.stringify(process.pid)+'\\n');setInterval(()=>{},1000)", marker);
    }
  } finally { await run("service", "remove", "worker").catch(() => {}); await rm(home, { recursive: true, force: true }); }
});

it("service resume tolerates owner publication between opening metadata and checking its inode", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "dim-guest-owner-publication-"));
  const env = { ...process.env, HOME: home };
  const run = (...args: string[]) => execute(process.execPath, [client, ...args], { cwd: home, env });
  try {
    const starts = path.join(home, "starts"), replaced = path.join(home, "replaced");
    await run("service", "register", "--name", "worker", "--", process.execPath, "-e",
      "require('node:fs').appendFileSync(process.argv[1],'started\\n');setInterval(()=>{},1000)", starts);
    await run("service", "resume");
    const owner = path.join(home, ".local/state/dim/services/worker.lock/owner.json");
    const preload = path.join(home, "replace-owner.cjs");
    // Reproduce the exact open -> atomic rename -> fstat interleaving, without
    // relying on the scheduler or weakening the file's permissions/ownership.
    await writeFile(preload, `
const fs = require('node:fs/promises');
const originalOpen = fs.open;
let replaced = false;
fs.open = async function(file, ...args) {
  const handle = await originalOpen.call(this, file, ...args);
  if (file === ${JSON.stringify(owner)} && !replaced) {
    replaced = true;
    const value = await fs.readFile(file);
    await fs.writeFile(file + '.replacement', value, { mode: 0o600, flag: 'wx' });
    await fs.rename(file + '.replacement', file);
    await fs.writeFile(${JSON.stringify(replaced)}, 'done');
  }
  return handle;
};
require('node:module').syncBuiltinESMExports();
`);
    await execute(process.execPath, ["--require", preload, client, "service", "resume"], { cwd: home, env });
    expect(await readFile(replaced, "utf8")).toBe("done");
    expect(JSON.parse((await run("service", "list")).stdout)).toEqual([{ name: "worker", running: true }]);
    expect((await readFile(starts, "utf8")).trim().split("\n")).toEqual(["started"]);
    // Stale inode handling must not accept a linked or non-private owner file.
    await link(owner, `${owner}.linked`);
    try { await expect(run("service", "resume")).rejects.toThrow(/private user-owned/); }
    finally { await rm(`${owner}.linked`); }
    await chmod(owner, 0o644);
    try { await expect(run("service", "resume")).rejects.toThrow(/private user-owned/); }
    finally { await chmod(owner, 0o600); }
  } finally { await run("service", "remove", "worker").catch(() => {}); await rm(home, { recursive: true, force: true }); }
});

it("service resume retries an exiting supervisor's guard instead of treating contention as readiness", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "dim-guest-service-handoff-"));
  const bin = path.join(home, "bin"), attempts = path.join(home, "attempts");
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` };
  await mkdir(bin);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(path.join(bin, "flock"), `#!/bin/sh\nprintf '%s\\n' attempt >> ${quote(attempts)}\nexec /usr/bin/flock "$@"\n`, { mode: 0o700 });
  const run = (...args: string[]) => execute(process.execPath, [client, ...args], { cwd: home, env });
  let released = false, resume: Promise<void> | undefined;
  const guard = path.join(home, ".local/state/dim/services/worker.lock.guard");
  await run("service", "register", "--name", "worker", "--", process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1],'started\\n');setInterval(()=>{},1000)", path.join(home, "starts"));
  await writeFile(guard, "", { mode: 0o600 }); const inode = (await stat(guard)).ino;
  // Model the precise interval after owner.json removal but before process exit:
  // the old kernel guard still exists and no live service can be claimed.
  const holder = spawn("/usr/bin/flock", ["--exclusive", "--no-fork", guard, process.execPath, "-e", "process.stdout.write('locked');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(holder.stdout!, "data");
    let finished = false; resume = run("service", "resume").then(() => { finished = true; });
    // Wait for a real retry while the guard remains held. The old implementation
    // instead finishes after its first conflict, which must fail this assertion.
    await expect.poll(async () => finished || (await readFile(attempts, "utf8").catch(() => "")).trim().split("\n").length >= 2).toBe(true);
    expect(finished).toBe(false);
    const closed = once(holder, "close"); holder.kill("SIGTERM"); await closed; released = true;
    await resume;
    await expect.poll(() => readFile(path.join(home, "starts"), "utf8")).toBe("started\n");
    expect((await stat(guard)).ino).toBe(inode);
    expect(JSON.parse((await run("service", "list")).stdout)).toEqual([{ name: "worker", running: true }]);
  } finally {
    if (!released) { const closed = once(holder, "close"); holder.kill("SIGTERM"); await closed; }
    await resume?.catch(() => {});
    await run("service", "remove", "worker").catch(() => {}); await rm(home, { recursive: true, force: true });
  }
});

it("one failed registered service does not prevent other independent services from starting", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "dim-guest-services-failure-"));
  const run = (...args: string[]) => execute(process.execPath, [client, ...args], { cwd: home, env: { ...process.env, HOME: home } });
  try {
    const marker = path.join(home, "healthy");
    await run("service", "register", "--name", "broken", "--", "/missing/service-command");
    await run("service", "register", "--name", "healthy", "--", process.execPath, "-e", `require('node:fs').writeFileSync(process.argv[1],'started');setInterval(()=>{},1000)`, marker);
    await expect(run("service", "resume")).rejects.toThrow(/some registered services failed: broken/);
    await expect.poll(() => readFile(marker, "utf8")).toBe("started");
    expect(JSON.parse((await run("service", "list")).stdout)).toEqual([{ name: "broken", running: false }, { name: "healthy", running: true }]);
  } finally { await run("service", "remove", "healthy").catch(() => {}); await rm(home, { recursive: true, force: true }); }
});

it("a supervisor terminated before readiness reports startup failure", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "dim-guest-service-terminated-"));
  const env = { ...process.env, HOME: home };
  try {
    await execute(process.execPath, [client, "service", "register", "--name", "worker", "--", "true"], { cwd: home, env });
    const bin = path.join(home, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "flock"), "#!/bin/sh\nkill -TERM $$\n", { mode: 0o700 });
    await expect(execute(process.execPath, [client, "service", "resume"], {
      cwd: home, env: { ...env, PATH: `${bin}:${process.env.PATH ?? ""}` }
    })).rejects.toThrow(/service 'worker' failed/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
