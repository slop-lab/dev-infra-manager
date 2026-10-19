import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const client = fileURLToPath(new URL("../../../../core/packages/core/src/workspace-image-assets/dim-workspace.mjs", import.meta.url));

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
      : request.url === "/v1/urls" ? { urls: [] } : { accepted: true }));
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
    await run("expose", "--name", "opencode", "--port", "4096", "--ingress", "https");
    await run("urls", "--json");
    expect(requests.slice(-4)).toEqual([
      { method: "POST", url: "/v1/restart", body: {} }, { method: "POST", url: "/v1/recreate", body: {} },
      { method: "POST", url: "/v1/expose", body: { name: "opencode", port: 4096, ingress: "https" } },
      { method: "GET", url: "/v1/urls", body: null }
    ]);
    const count = requests.length;
    await expect(run("restart", "--workspace", "other")).rejects.toThrow();
    await expect(run("expose", "--name", "x", "--port", "4096", "--ingress", "https", "--host", "foreign")).rejects.toThrow();
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
