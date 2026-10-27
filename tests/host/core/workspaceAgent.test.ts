import { randomUUID } from "node:crypto";
import { once } from "node:events";
import childProcess, { execFile, type SpawnOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { request as httpRequest } from "node:http";
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessRunner, WorkspaceService, WorkspaceStore, type WorkspaceRuntime } from "@slop-lab/dim-host-core/workspace";
import { loadHostPlugins } from "../../../packages/host/core/src/application/host-plugins.js";
import { createWorkspaceAgentServer, ensureWorkspaceAgent, runWorkspaceAgent, workspaceAgentGeneration } from "../../../packages/host/core/src/application/workspace-agent.js";
import { workspaceAgentCodeFingerprint, workspaceAgentGenerationInputFiles } from "../../../packages/host/core/src/application/workspace-agent-state.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(cleanup.splice(0).map((action) => action())); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dim-scoped-workspace-"));
  const calls: string[] = [];
  vi.stubEnv("DIM_PLUGIN_HOME", path.join(root, "plugins"));
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
  const server = createWorkspaceAgentServer({ workspaceId: record.id, workspaceName: record.name, stateRoot: root, host: "127.0.0.1", token, generation: "c".repeat(64) }, {
    service, store, runtime, stateRoot: root, runner, cleanupRunner: runner, signal: new AbortController().signal
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP listener");
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const request = (pathname: string, options: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${pathname}`, {
    ...options, headers: { authorization: `Bearer ${token}`, ...options.headers }, signal: AbortSignal.timeout(2_000)
  });
  return { root, store, service, record, request, calls, restartCompleted, server, runtime };
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
          ...options, cwd: home, env: { ...process.env, HOME: home }
        })).exitCode;
      }
    };
    const service = new WorkspaceService(store, runtime, async ({ destination }) => { await mkdir(destination); return { url: "source", ref: "main", commit: "a".repeat(40) }; });
    const record = await service.create({ name: "dev", source: { url: "source" } });
    vi.stubEnv("DIM_PLUGIN_HOME", path.join(root, "no-plugins"));
    const generation = await workspaceAgentGeneration();
    const connection = { generation, workspaceId: record.id, workspaceName: record.name, stateRoot: state, host: "127.0.0.1", token: "a".repeat(43) };
    const directory = path.join(state, "agents", record.id);
    await mkdir(directory, { recursive: true }); await mkdir(guest, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, "config.json"), JSON.stringify(connection), { mode: 0o600 });
    await writeFile(path.join(directory, "ready.json"), JSON.stringify({ endpoint: "http://127.0.0.1:12345", workspaceId: record.id }), { mode: 0o600 });
    await writeFile(path.join(guest, "workspace.json.tmp-42"), "interrupted earlier guest process");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { headers: { "x-dim-bridge-generation": generation, "x-dim-channel-ready": "1" } }));
    vi.stubEnv("DIM_PLUGIN_HOME", path.join(root, "no-plugins"));
    const bin = path.join(home, ".local/bin"); await mkdir(bin, { recursive: true, mode: 0o700 });
    await writeFile(path.join(bin, "dim-workspace"), "#!/bin/sh\necho obsolete-image-client\n", { mode: 0o700 });
    const context = { store, service, runtime, runner, cleanupRunner: runner, stateRoot: state, signal: AbortSignal.timeout(5000) };
    try {
      await ensureWorkspaceAgent(record, context);
      expect(JSON.parse(await readFile(path.join(guest, "workspace.json"), "utf8"))).toEqual({ endpoint: "http://127.0.0.1:19420/services/workspace", workspaceId: record.id, token: connection.token });
      expect((await stat(path.join(guest, "workspace.json"))).mode & 0o777).toBe(0o600);
      expect(await readFile(path.join(bin, "dim-workspace"), "utf8")).toContain("/v1/plugins");
      const discovery = JSON.parse(await readFile(path.join(home, ".config/dim/discovery.json"), "utf8"));
      expect(discovery).toMatchObject({ schemaVersion: 1, delivery: "readiness-cache", workspace: { id: record.id, runtime: record.runtime } });
      expect(discovery.agent).not.toHaveProperty("mode");
      const skill = await readFile(path.join(home, ".agents/skills/dim-environment/SKILL.md"), "utf8");
      expect(skill.startsWith("---\nname: dim-environment\n")).toBe(true);
      if (process.env.DIM_SKILL_VALIDATOR) await promisify(execFile)("python3", [process.env.DIM_SKILL_VALIDATOR,
        path.join(home, ".agents/skills/dim-environment")], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
      await expect(stat(path.join(home, ".dim"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(promisify(execFile)(process.execPath, [path.join(bin, "dim-workspace"), "plugin", "example", "run", "not-json"], { env: { ...process.env, HOME: home } })).rejects.toThrow(/Unexpected token/);
      const first = await readFile(path.join(directory, "config.json"), "utf8");
      await ensureWorkspaceAgent(record, context);
      expect(await readFile(path.join(directory, "config.json"), "utf8")).toBe(first);
      await rm(path.join(guest, "workspace.json")); await mkdir(path.join(guest, "workspace.json"));
      await expect(ensureWorkspaceAgent(record, context)).rejects.toThrow(/cannot safely prepare/);
      expect((await readdir(guest)).sort()).toEqual(["discovery.json", "workspace.json", "workspace.json.tmp-42"]);
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


async function guestPlugin(root: string, source: string): Promise<void> {
  const home = path.join(root, "plugins"), directory = path.join(home, "node_modules", "fixture");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(home, "package.json"), JSON.stringify({ private: true }));
  await writeFile(path.join(home, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: ["fixture"] }));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
  await writeFile(path.join(directory, "index.js"), `// @ts-check\n${source}`);
}

it("discovers installed guest integrations without exposing handlers/config and dispatches only their scoped operations", async () => {
  const f = await fixture();
  await guestPlugin(f.root, `export const hostPlugin={name:'example',guest:{description:'Example integration',
    commands:[{name:'dim-example',description:'Example client',secret:'not public'}],
    inspect:async()=>({state:'unconfigured',message:'Ask the operator to configure this integration',token:'not public'}),
    operations:[{name:'submit',description:'Submit scoped data',handle:async(input,workspace)=>({input,workspaceId:workspace.id})}],
    secret:'not public'},workspaceCapabilities:async()=>[{name:'kvm.direct-access',description:'Scoped accelerator',state:'blocked',
      reason:{code:'operator-grant-required',message:'An operator grant is required'},access:{kind:'none'},secret:'not public'}]};`);
  expect(await (await f.request("/v1/plugins")).json()).toEqual({ plugins: [{ name: "example", description: "Example integration",
    commands: [{ name: "dim-example", description: "Example client" }], operations: [{ name: "submit", description: "Submit scoped data" }],
    state: "unconfigured", message: "Ask the operator to configure this integration" }] });
  const response = await f.request("/v1/plugins/example/submit", { method: "POST", body: JSON.stringify({ custom: [1, 2] }) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ input: { custom: [1, 2] }, workspaceId: f.record.id });
  expect((await f.request("/v1/plugins/unknown/submit", { method: "POST", body: "{}" })).status).toBe(404);
  expect((await f.request("/v1/plugins/example/missing", { method: "POST", body: "{}" })).status).toBe(404);
  expect((await f.request("/v1/plugins/example/submit?workspace=other", { method: "POST", body: "{}" })).status).toBe(404);
  expect((await f.request("/v1/expose", { method: "POST", body: "{}" })).status).toBe(404);
  expect((await f.request("/v1/plugins", { headers: { authorization: "Bearer wrong" } })).status).toBe(403);
  expect((await f.request("/v1/plugins/example/submit", { method: "POST", body: "{}", headers: { origin: "https://foreign.invalid" } })).status).toBe(403);
  await f.store.write({ ...f.record, source: { ...f.record.source, url: "https://token@example.invalid/root.git", workingDirectory: "docs",
    checkouts: [{ directory: "docs", source: { url: "https://secret@example.invalid/docs.git", ref: "refs/heads/main", commit: "b".repeat(40) } }] } });
  const discovery = await (await f.request("/v1/discovery")).json();
  expect(discovery).toMatchObject({ schemaVersion: 1, delivery: "online",
    host: { hostname: expect.any(String), version: expect.any(String) },
    observedAt: expect.any(String),
    executionEnvironment: { location: "workspace", boundary: "workspace-runtime", runtime: f.record.runtime,
      runtimeStatus: "running", isolation: { kind: "container", owner: "core" } },
    authorization: { scope: "workspace", workspaceId: f.record.id, transport: "scoped-bearer", acceptsWorkspaceSelector: false },
    agent: { guidance: { name: "dim-environment", provenance: "host-core-built-in", refresh: "workspace-readiness" } },
    freshness: { observedAt: expect.any(String), workspaceUpdatedAt: f.record.updatedAt,
      bridgeGeneration: "c".repeat(64), pluginManifestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) },
    pluginSet: ["example"],
    serviceEndpoints: [{ owner: "core", name: "workspace", endpoint: "http://127.0.0.1:19420/services/workspace", availability: "available", readiness: "online",
      authorization: { scope: "workspace", workspaceId: f.record.id } }],
    workspace: { id: f.record.id, runtime: f.record.runtime,
    source: { workingDirectory: "docs", freshness: { state: "recorded", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) },
      checkouts: [{ directory: "docs", ref: "refs/heads/main", commit: "b".repeat(40) }] } },
    capabilities: [{ owner: "example", name: "kvm.direct-access", state: "blocked",
      scope: { kind: "workspace", workspaceId: f.record.id }, reason: { code: "operator-grant-required" }, access: { kind: "none" } }],
    developerCapabilities: [] });
  expect(JSON.stringify(discovery)).not.toContain("not public");
  expect(JSON.stringify(discovery)).not.toContain("secret@example.invalid");
  expect(discovery.agent).not.toHaveProperty("mode");
  expect((await f.request("/v1/discovery", { headers: { authorization: "Bearer wrong" } })).status).toBe(403);
  const originalFingerprint = discovery.workspace.source.freshness.fingerprint;
  await f.store.write({ ...(await f.store.read(f.record.name)), updatedAt: "2026-10-27T04:00:00.000Z",
    source: { ...(await f.store.read(f.record.name)).source, commit: "c".repeat(40) } });
  const refreshedSource = await (await f.request("/v1/discovery")).json();
  expect(refreshedSource.workspace.source).toMatchObject({ commit: "c".repeat(40),
    freshness: { state: "recorded", recordUpdatedAt: "2026-10-27T04:00:00.000Z" } });
  expect(refreshedSource.workspace.source.freshness.fingerprint).not.toBe(originalFingerprint);
  f.runtime.inspect = async () => ({ running: false });
  expect((await f.request("/v1/plugins")).status).toBe(409);
  expect((await f.request("/v1/plugins/example/submit", { method: "POST", body: "{}" })).status).toBe(409);
  f.runtime.inspect = async () => ({ running: true });
  await f.store.write({ ...f.record, phase: "stopped" });
  expect((await f.request("/v1/plugins")).status).toBe(409);
  expect((await f.request("/v1/plugins/example/submit", { method: "POST", body: "{}" })).status).toBe(409);
  await f.store.write({ ...f.record, id: randomUUID() });
  expect((await f.request("/v1/plugins/example/submit", { method: "POST", body: "{}" })).status).toBe(410);
});

it("discovers command-only integrations and rejects duplicate operation declarations", async () => {
  const f = await fixture();
  await guestPlugin(f.root, `export const hostPlugin={name:'client',guest:{description:'Client-only',commands:[{name:'dim-client',description:'Run client'}]}};`);
  expect(await (await f.request("/v1/plugins")).json()).toEqual({ plugins: [{ name: "client", description: "Client-only", state: "ready", commands: [{ name: "dim-client", description: "Run client" }], operations: [] }] });
  // A fresh module path makes this an independent installed-module declaration.
  const other = await mkdtemp(path.join(os.tmpdir(), "dim-invalid-guest-")); cleanup.push(() => rm(other, { recursive: true, force: true }));
  await guestPlugin(other, `export const hostPlugin={name:'invalid',guest:{description:'Invalid',operations:[{name:'run',description:'One',handle:async()=>null},{name:'run',description:'Two',handle:async()=>null}]}};`);
  vi.stubEnv("DIM_PLUGIN_HOME", path.join(other, "plugins"));
  await expect(loadHostPlugins()).rejects.toThrow(/duplicate guest operations/);
});


it("rechecks UUID after a slow plugin request body, before dispatching its operation", async () => {
  const f = await fixture();
  await guestPlugin(f.root, `export const hostPlugin={name:'example',guest:{description:'Scoped',operations:[{name:'run',description:'Run',handle:async()=>({dispatched:true})}]}};`);
  const address = f.server.address(); if (!address || typeof address === "string") throw new Error("missing listener");
  let reading!: () => void;
  const bodyReaderStarted = new Promise<void>((resolve) => { reading = resolve; });
  f.server.once("request", (incoming) => {
    incoming.on("newListener", (event) => { if (event === "readable") reading(); });
  });
  const response = new Promise<number>((resolve, reject) => {
    const client = httpRequest({ host: "127.0.0.1", port: address.port, path: "/v1/plugins/example/run", method: "POST", headers: { authorization: `Bearer ${"a".repeat(43)}`, "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    client.on("error", reject); client.write("{");
    void bodyReaderStarted.then(async () => { await f.store.write({ ...f.record, id: randomUUID() }); client.end("}"); }).catch(reject);
  });
  expect(await response).toBe(410);
});

it("rechecks UUID after slow owner capability discovery", async () => {
  const f = await fixture();
  await guestPlugin(f.root, `let started;export const capabilityStarted=new Promise(resolve=>{started=resolve});
    let release;export const releaseCapability=()=>release();
    export const hostPlugin={name:'example',workspaceCapabilities:async()=>{started();await new Promise(resolve=>{release=resolve});
      return [{name:'accelerator',description:'Scoped accelerator',state:'available',access:{kind:'workspace-local'}}]}};`);
  const installed = await import(pathToFileURL(path.join(f.root, "plugins/node_modules/fixture/index.js")).href);
  const response = f.request("/v1/discovery");
  await installed.capabilityStarted;
  await f.store.write({ ...f.record, id: randomUUID() });
  installed.releaseCapability();
  expect((await response).status).toBe(410);
});

it("keeps discovery available when optional plugin inspection fails", async () => {
  const f = await fixture();
  await guestPlugin(f.root, `export const hostPlugin={name:'example',guest:{description:'Optional',inspect:async()=>{throw Error('secret provider detail')}},
    workspaceCapabilities:async()=>{throw Error('secret capability detail')}};`);
  const response = await f.request("/v1/discovery");
  expect(response.status).toBe(200);
  const value = await response.json();
  expect(value).toMatchObject({ plugins: [{ owner: "example", state: "unavailable" }], capabilities: [{ owner: "example", name: "provider",
    state: "unavailable", reason: { code: "provider-failed" }, access: { kind: "none" } }] });
  expect(JSON.stringify(value)).not.toContain("secret");
});

it("summarizes only currently available developer capabilities", async () => {
  const f = await fixture();
  await guestPlugin(f.root, `export const hostPlugin={name:'example',guest:{description:'Optional',operations:[{name:'verify',description:'Verify',handle:async()=>null}]},
    workspaceCapabilities:async()=>[{name:'direct-access',description:'Direct access',state:'available',access:{kind:'workspace-local'}},
      {name:'vm-fd-verification',description:'VM fd',state:'available',reason:{code:'verified',message:'Current fact',token:'nested-reason-secret'},
        access:{kind:'guest-operation',operation:'verify',token:'nested-access-secret'}},
      {name:'boot',description:'Boot',state:'blocked',reason:{code:'not-authorized',message:'Not authorized'},access:{kind:'none'}}]};`);
  const value = await (await f.request("/v1/discovery")).json();
  expect(value).toMatchObject({ developerCapabilities: [
    { owner: "example", name: "direct-access", access: { kind: "workspace-local" } },
    { owner: "example", name: "vm-fd-verification", access: { kind: "guest-operation", operation: "verify" } }
  ] });
  expect(JSON.stringify(value)).not.toContain("nested-access-secret");
  expect(JSON.stringify(value)).not.toContain("nested-reason-secret");
});


it("discovers the installed tools, router and external URLs together over the actual scoped endpoint", async () => {
  const f = await fixture();
  vi.stubEnv("DIM_EXTERNAL_URL_CONFIG", path.join(f.root, "unconfigured-ingress.json"));
  const selections = ["agent-tools", "host-llm-router", "external-urls"];
  for (const name of selections) {
    const installed = path.join(f.root, "plugins", "node_modules", "@slop-lab", `dim-host-plugin-${name.replace(/^host-/, "")}`);
    await mkdir(path.dirname(installed), { recursive: true });
    await symlink(new URL(`../../../packages/host/plugins/${name.replace(/^host-/, "")}`, import.meta.url).pathname, installed);
  }
  await writeFile(path.join(f.root, "plugins", "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: selections.map((name) => `@slop-lab/dim-host-plugin-${name.replace(/^host-/, "")}`) }));
  const response = await f.request("/v1/plugins"); expect(response.status).toBe(200);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("plugins" in value) || !Array.isArray(value.plugins)) throw new Error("missing discovery list");
  expect(value.plugins.map((entry: { name: string }) => entry.name)).toEqual(["agent-tools", "host-llm-router", "external-urls"]);
  const discovery: unknown = await (await f.request("/v1/discovery")).json();
  if (!discovery || typeof discovery !== "object" || !("plugins" in discovery) || !Array.isArray(discovery.plugins)) throw new Error("missing discovery plugins");
  expect(discovery.plugins.map((entry: { owner: string }) => entry.owner)).toEqual(["agent-tools", "host-llm-router", "external-urls"]);
  const external: unknown = value.plugins[2];
  expect(external).toMatchObject({ state: "unconfigured", commands: [{ name: "dim-expose" }] });
  for (const entry of value.plugins as unknown[]) {
    if (!entry || typeof entry !== "object") throw new Error("invalid integration");
    expect(Object.keys(entry).every((key) => ["name", "description", "commands", "operations", "state", "message"].includes(key))).toBe(true);
  }
  await writeFile(path.join(f.root, "plugins", "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: ["@slop-lab/dim-host-plugin-agent-tools"] }));
  const refreshed: unknown = await (await f.request("/v1/discovery")).json();
  if (!refreshed || typeof refreshed !== "object" || !("plugins" in refreshed) || !Array.isArray(refreshed.plugins)) throw new Error("missing refreshed discovery plugins");
  expect(refreshed.plugins.map((entry: { owner: string }) => entry.owner)).toEqual(["agent-tools"]);
});


it("fingerprints enabled module bytes and transactional runtime replacement without per-plugin callbacks", async () => {
  const f = await fixture();
  await guestPlugin(f.root, `export const hostPlugin={name:'example'};`);
  const initial = await workspaceAgentGeneration();
  expect(await workspaceAgentGeneration()).toBe(initial);
  const home = path.join(f.root, "plugins"), entry = path.join(home, "node_modules/fixture/index.js");
  await writeFile(entry, "// @ts-check\nexport const hostPlugin={name:'example',version:'updated'};");
  const updated = await workspaceAgentGeneration(); expect(updated).not.toBe(initial);
  await rename(home, `${home}-old`); await cp(`${home}-old`, home, { recursive: true });
  const promoted = await workspaceAgentGeneration(); expect(promoted).not.toBe(updated);
  await writeFile(path.join(home, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: [] }));
  expect(await workspaceAgentGeneration()).not.toBe(promoted);
});

it("binds discovery implementation and trusted guest assets into the bridge generation", async () => {
  const names = workspaceAgentGenerationInputFiles().map((file) => path.basename(file));
  expect(names).toEqual(expect.arrayContaining([
    "workspace-discovery.ts", "guestAssets.ts", "dim-workspace.mjs", "dim-environment.SKILL.md", "dim-nproc", "dim-workspace-ssh.bash"
  ]));
  const root = await mkdtemp(path.join(os.tmpdir(), "dim-discovery-generation-"));
  try {
    const discovery = path.join(root, "workspace-discovery.ts");
    await writeFile(discovery, "export const schemaVersion = 1;\n");
    const initial = await workspaceAgentCodeFingerprint([discovery]);
    await writeFile(discovery, "export const schemaVersion = 2;\n");
    expect(await workspaceAgentCodeFingerprint([discovery])).not.toBe(initial);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("replaces an older bridge protocol once, rotates its token and publishes the new guest client centrally", async () => {
  const f = await fixture(), home = path.join(f.root, "home");
  await mkdir(home, { mode: 0o700 });
  const runner = new ProcessRunner(); f.runtime.hostGateway = async () => "10.0.0.1";
  f.runtime.exec = async (_record, command, options) => (await runner.run(process.execPath, [...command.slice(1)], { ...options, env: { ...process.env, HOME: home } })).exitCode;
  const context = { service: f.service, store: f.store, runtime: f.runtime, runner, cleanupRunner: runner, stateRoot: f.store.root, signal: AbortSignal.timeout(5000) };
  const root = path.join(f.store.root, "agents", f.record.id), file = path.join(root, "config.json"), pidFile = path.join(f.root, "bridge.pid");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const token = "a".repeat(43);
  await writeFile(file, JSON.stringify({ workspaceId: f.record.id, workspaceName: f.record.name, stateRoot: f.store.root, host: "10.0.0.1", token }), { mode: 0o600 });
  await writeFile(path.join(root, "ready.json"), JSON.stringify({ endpoint: "http://10.0.0.1:11111", workspaceId: f.record.id }), { mode: 0o600 });
  const script = path.join(f.root, "new-bridge.mjs");
  await writeFile(script, `// @ts-check
import {readFileSync,writeFileSync} from 'node:fs';import path from 'node:path';
const file=process.argv.at(-1);if(!file)throw Error('missing configuration');const c=JSON.parse(readFileSync(file,'utf8'));
writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
writeFileSync(path.join(path.dirname(file),'ready.json'),JSON.stringify({endpoint:'http://127.0.0.1:22222',workspaceId:c.workspaceId}),{mode:0o600});
setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));
`);
  let oldProbes = 0, newProbes = 0;
  const probe = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    if (String(url).includes(":11111/")) { oldProbes++; return new Response("{}", { status: 200 }); }
    newProbes++;
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || !("token" in value) || !("generation" in value) || typeof value.generation !== "string") throw new Error("invalid new config");
    expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${value.token}`);
    return new Response("{}", { headers: { "x-dim-bridge-generation": value.generation, "x-dim-channel-ready": "1" } });
  });
  const spawn = childProcess.spawn;
  const launch = vi.spyOn(childProcess, "spawn").mockImplementation(((command: string, argumentsOrOptions?: readonly string[] | SpawnOptions, options: SpawnOptions = {}) => {
    const args = Array.isArray(argumentsOrOptions) ? argumentsOrOptions : [];
    const settings = argumentsOrOptions && !Array.isArray(argumentsOrOptions) ? argumentsOrOptions as SpawnOptions : options;
    if (args?.some((argument) => /workspace-agent-process\.(?:ts|js)$/.test(argument))) {
      // Replace only the detached bridge process; real guest writes still use
      // their exact runtime subprocess. No CLI launcher participates.
      return spawn(command, [script, file], settings);
    }
    return spawn(command, args, settings);
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  try {
    await ensureWorkspaceAgent(f.record, context);
    const configured: unknown = JSON.parse(await readFile(file, "utf8"));
    expect(configured).toMatchObject({ workspaceId: f.record.id, generation: await workspaceAgentGeneration() });
    if (!configured || typeof configured !== "object" || !("token" in configured)) throw new Error("missing token");
    expect(configured.token).not.toBe(token); expect(oldProbes).toBe(0); expect(newProbes).toBeGreaterThan(0);
    const guest: unknown = JSON.parse(await readFile(path.join(home, ".config/dim/workspace.json"), "utf8"));
    expect(guest).toMatchObject({ workspaceId: f.record.id, token: configured.token, endpoint: "http://127.0.0.1:19420/services/workspace" });
    await ensureWorkspaceAgent(f.record, context);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(configured);
    const stale = { ...configured, generation: "0".repeat(64) };
    await writeFile(file, JSON.stringify(stale), { mode: 0o600 });
    await expect(runWorkspaceAgent(file)).rejects.toThrow(/generation changed before startup/);
  } finally {
    launch.mockRestore(); syncBuiltinESMExports(); probe.mockRestore();
    try { process.kill(Number(await readFile(pidFile, "utf8")), "SIGTERM"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
});
