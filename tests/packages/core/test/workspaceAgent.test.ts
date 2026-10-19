import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessRunner, WorkspaceService, WorkspaceStore, type WorkspaceRuntime } from "@slop-lab/dim-core/workspace";
import { createWorkspaceAgentServer, ensureWorkspaceAgent } from "../../../../core/packages/cli/src/workspace-agent.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((action) => action())); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dim-scoped-workspace-"));
  const calls: string[] = [];
  const runtime: WorkspaceRuntime = {
    async inspect() { return { running: true }; }, async create() {}, async seed() {},
    async start() { calls.push("start"); }, async stop() { calls.push("stop"); },
    async remove() { calls.push("remove"); }, async updateResources() { return { recreated: false }; },
    async exec() { return 0; }, async connect() { return 0; }
  };
  const store = new WorkspaceStore(root);
  const service = new WorkspaceService(store, runtime, async ({ destination }) => {
    await mkdir(destination); return { url: "https://example.invalid/app.git", ref: "refs/heads/main", commit: "a".repeat(40) };
  });
  const record = await service.create({ name: "dev", source: { url: "https://example.invalid/app.git" } });
  let restarted!: () => void;
  const restartCompleted = new Promise<void>((resolve) => { restarted = resolve; });
  const restart = service.restart.bind(service);
  service.restart = async (...args) => { try { return await restart(...args); } finally { restarted(); } };
  calls.length = 0;
  const token = "a".repeat(43), runner = new ProcessRunner();
  const server = createWorkspaceAgentServer({ workspaceId: record.id, workspaceName: record.name, stateRoot: root, host: "127.0.0.1", token }, {
    service, store, runtime, stateRoot: root, runner, cleanupRunner: runner, signal: new AbortController().signal
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP listener");
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const request = (pathname: string, options: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${pathname}`, {
    ...options, headers: { authorization: `Bearer ${token}`, ...options.headers }, signal: AbortSignal.timeout(2_000)
  });
  return { store, service, record, request, calls, restartCompleted };
}

describe("workspace-scoped agent gateway", () => {
  it("refreshes guest connection despite reused PIDs and cleans its own temporary file after a failed rename", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dim-agent-connection-"));
    const home = path.join(root, "home"), state = path.join(root, "state"), guest = path.join(home, ".config/dim");
    const runner = new ProcessRunner(), store = new WorkspaceStore(state);
    const runtime: WorkspaceRuntime = {
      async inspect() { return { running: true }; }, async create() {}, async seed() {}, async start() {}, async stop() {}, async remove() {},
      async updateResources() { return { recreated: false }; }, async connect() { return 0; }, async hostGateway() { return "10.0.0.1"; },
      async exec(_record, command, options) {
        const script = command.at(-1); if (!script) throw new Error("missing guest writer");
        return (await runner.run(process.execPath, ["--input-type=commonjs", "-e", `Object.defineProperty(process,'pid',{value:42});${script}`], {
          ...options, env: { ...process.env, HOME: home }
        })).exitCode;
      }
    };
    const service = new WorkspaceService(store, runtime, async ({ destination }) => { await mkdir(destination); return { url: "source", ref: "main", commit: "a".repeat(40) }; });
    const record = await service.create({ name: "dev", source: { url: "source" } });
    const connection = { workspaceId: record.id, workspaceName: record.name, stateRoot: state, host: "10.0.0.1", token: "a".repeat(43) };
    const directory = path.join(state, "agents", record.id);
    await mkdir(directory, { recursive: true }); await mkdir(guest, { recursive: true });
    await writeFile(path.join(directory, "config.json"), JSON.stringify(connection), { mode: 0o600 });
    await writeFile(path.join(directory, "ready.json"), JSON.stringify({ endpoint: "http://10.0.0.1:12345", workspaceId: record.id }), { mode: 0o600 });
    await writeFile(path.join(guest, "workspace.json.tmp-42"), "interrupted earlier guest process");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
    vi.stubEnv("DIM_PLUGIN_HOME", path.join(root, "no-plugins"));
    const context = { store, service, runtime, runner, cleanupRunner: runner, stateRoot: state, signal: AbortSignal.timeout(5000) };
    try {
      await ensureWorkspaceAgent(record, context);
      expect(JSON.parse(await readFile(path.join(guest, "workspace.json"), "utf8"))).toEqual({ endpoint: "http://10.0.0.1:12345", workspaceId: record.id, token: connection.token });
      expect((await stat(path.join(guest, "workspace.json"))).mode & 0o777).toBe(0o600);
      await rm(path.join(guest, "workspace.json")); await mkdir(path.join(guest, "workspace.json"));
      await expect(ensureWorkspaceAgent(record, context)).rejects.toThrow(/cannot install/);
      expect((await readdir(guest)).sort()).toEqual(["workspace.json", "workspace.json.tmp-42"]);
      expect(await readFile(path.join(guest, "workspace.json.tmp-42"), "utf8")).toBe("interrupted earlier guest process");
    } finally { fetch.mockRestore(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });

  it("returns current assigned resources and denies foreign tokens, browser origins and admin paths", async () => {
    const f = await fixture();
    expect(await (await f.request("/v1/resources")).json()).toEqual(f.record.resources);
    await f.store.write({ ...f.record, resources: { cpuCount: "2.5", memory: "unlimited", pidsLimit: "4096" } });
    expect(await (await f.request("/v1/resources")).json()).toEqual({ cpuCount: "2.5", memory: "unlimited", pidsLimit: "4096" });
    expect((await f.request("/v1/resources", { headers: { authorization: "Bearer wrong" } })).status).toBe(403);
    expect((await f.request("/v1/resources", { headers: { origin: "https://attacker.invalid" } })).status).toBe(403);
    expect((await f.request("/v1/admin")).status).toBe(404);
    expect((await f.request("/v1/resources?workspace=foreign")).status).toBe(404);
    expect((await f.request("/v1/restart", { method: "POST", body: '{"workspace":"foreign"}' })).status).toBe(400);
    expect(f.calls).toEqual([]);
  });

  it("accepts a self restart and fences the queued operation against display-name reuse", async () => {
    const f = await fixture();
    await f.store.withLock(f.record.name, async () => {
      expect((await f.request("/v1/restart", { method: "POST", body: "{}" })).status).toBe(202);
      await f.store.write({ ...f.record, id: randomUUID() });
    });
    await f.restartCompleted;
    expect(f.calls).toEqual([]);
    expect((await f.request("/v1/resources")).status).toBe(410);
  });

  it("performs restart only on its own current UUID and keeps the workspace data", async () => {
    const f = await fixture();
    expect((await f.request("/v1/restart", { method: "POST", body: "{}" })).status).toBe(202);
    await f.restartCompleted;
    expect(f.calls).toEqual(["stop", "start"]);
    expect((await f.store.read(f.record.name)).id).toBe(f.record.id);
  });
});
