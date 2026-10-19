import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceStore, WorkspaceService, ContainerWorkspaceRuntime, ProcessRunner, type WorkspaceHostPluginContext } from "@slop-lab/dim-core/workspace";
import { backupRouter, restoreRouter } from "../../../../plugin-control-plane-llm-router/src/operator.js";
import { loadConfig } from "../../../../plugin-control-plane-llm-router/src/config.js";
import { createRouter } from "../../../../plugin-control-plane-llm-router/src/server.js";
import { parseConfig, backendProfile, defaultLimits } from "../../../../plugin-control-plane-llm-router/src/config.js";
import { createHostGateway } from "../../../../plugin-host-llm-router/src/gateway.js";
import { issuePrincipal, revokePrincipal } from "../../../../plugin-host-llm-router/src/client.js";
import { loadHostConfig } from "../../../../plugin-host-llm-router/src/config.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";
const { runLlmCommand } = await import(new URL("cli.js", process.env.DIM_TEST_ROUTER_DIST ?? new URL("../../../../plugin-host-llm-router/dist/", import.meta.url)).href) as typeof import("../../../../plugin-host-llm-router/src/cli.js");
const { hostPlugin } = await import(new URL("index.js", process.env.DIM_TEST_ROUTER_DIST ?? new URL("../../../../plugin-host-llm-router/dist/", import.meta.url)).href) as typeof import("../../../../plugin-host-llm-router/src/index.js");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no listener");
  return `http://127.0.0.1:${address.port}`;
}
async function fixture(stream = false) {
  const root = await mkdtemp(join(tmpdir(), "dim-llm-separated-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  let upstreamClosed = false, seenAuthorization: string | undefined;
  const backend = createServer((request, response) => {
    seenAuthorization = request.headers.authorization;
    response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
    if (stream) { response.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'); response.once("close", () => { upstreamClosed = true; }); }
    else response.end('{"status":"completed","model":"reviewed-model","usage":{"input_tokens":2,"output_tokens":1}}');
  });
  const backendOrigin = await listen(backend); cleanup.push(async () => { backend.closeAllConnections(); await new Promise<void>((resolve) => backend.close(() => resolve())); });
  const backendKey = "private-backend-key", issuerKey = randomBytes(32).toString("base64url");
  await writeFile(join(root, "backend.key"), backendKey, { mode: 0o600 }); await writeFile(join(root, "issuer.key"), issuerKey, { mode: 0o600 });
  await writeFile(join(root, "issuer-b.key"), randomBytes(32).toString("base64url"), { mode: 0o600 });
  const cpConfig = parseConfig({ schemaVersion: 3, stateDirectory: join(root, "cp"),
    hostIssuers: [{ id: "host-a", keyFile: join(root, "issuer.key"), projects: [{ id: "application", routeIds: ["default", "secondary"] }] },
      { id: "host-b", keyFile: join(root, "issuer-b.key"), projects: [{ id: "application", routeIds: ["default", "secondary"] }] }],
    listen: { host: "127.0.0.1", port: 8318 }, backend: backendProfile,
    accounts: [{ id: "default", reference: "exclusive-account", endpoint: backendOrigin, keyFile: join(root, "backend.key") }],
    routes: ["default", "secondary"].map((id) => ({ id, accountId: "default", models: [{ id: "reviewed-model", name: "Reviewed", api: "responses", context: 10000, output: 1000 }] })), limits: defaultLimits });
  const cp = await createRouter(cpConfig);
  const cpOrigin = await listen(cp.server); cleanup.push(() => cp.close());
  cp.ledger.createProject("application", { allowedRoutes: ["default", "secondary"], limits: defaultLimits, captureMode: "required", tokenMode: "observe" });
  const store = new WorkspaceStore(join(root, "host-workspaces")), workspace = workspaceRecord(); await store.write(workspace);
  const runner = new ProcessRunner(), service = new WorkspaceService(store, new ContainerWorkspaceRuntime(runner), async () => { throw new Error("unexpected acquisition"); });
  const context: WorkspaceHostPluginContext = { runner, cleanupRunner: runner, stateRoot: store.root, store, service, signal: new AbortController().signal };
  vi.spyOn(console, "log").mockImplementation(() => {});
  const directory = join(root, "host");
  await runLlmCommand(["llm", "prepare", directory, "--control-plane", cpOrigin, "--issuer", "host-a", "--issuer-key-file", join(root, "issuer.key"), "--endpoint", "http://127.0.0.1:8319"], context);
  const configPath = join(directory, "gateway.json"), config = await loadHostConfig(configPath);
  const gateway = await createHostGateway(config, store), gatewayOrigin = await listen(gateway.server); cleanup.push(() => gateway.close());
  config.publicEndpoint = gatewayOrigin; await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const home = join(root, "guest-home"); await mkdir(home, { mode: 0o700 });
  const guestEnvironment = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  vi.spyOn(service, "exec").mockImplementation(async (name, args, options) => {
    expect(name).toBe(workspace.name); expect(options?.workspaceId).toBe(workspace.id);
    const chunks: Buffer[] = []; if (options?.stdin) for await (const chunk of options.stdin) chunks.push(Buffer.from(chunk));
    return new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, args.slice(1), { env: guestEnvironment, stdio: ["pipe", "pipe", "pipe"] });
      if (options?.stdout) child.stdout.pipe(options.stdout, { end: false }); else child.stdout.resume();
      child.stderr.resume(); child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); child.stdin.end(Buffer.concat(chunks));
    });
  });
  await runLlmCommand(["llm", "attach", workspace.name, "--config", configPath, "--project", "application"], context);
  const connectionPath = join(home, ".config/dim/llm-router.json");
  const connection: unknown = JSON.parse(await readFile(connectionPath, "utf8"));
  if (typeof connection !== "object" || connection === null || !("token" in connection) || typeof connection.token !== "string") throw new Error("missing guest token");
  const token = connection.token;
  const request = () => fetch(gatewayOrigin + "/v1/responses", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "reviewed-model", input: "hello", stream }) });
  return { root, home, guestEnvironment, store, workspace, context, config, cpConfig, cp, cpOrigin, gatewayOrigin, connectionPath, connection, token, request,
    backendKey, issuerKey, upstreamClosed: () => upstreamClosed, seenAuthorization: () => seenAuthorization };
}
it("attaches a local-only guest credential and forwards through independently configured control-plane authority", async () => {
  const f = await fixture(), response = await f.request(); expect(response.status).toBe(200); await response.text();
  expect(f.seenAuthorization()).toBe(`Bearer ${f.backendKey}`);
  expect(f.cp.ledger.authenticate(f.token)).toBeUndefined();
  expect(JSON.stringify(f.connection)).not.toContain(f.backendKey); expect(JSON.stringify(f.connection)).not.toContain(f.issuerKey);
  expect((await fetch(f.cpOrigin + "/v1/models", { headers: { authorization: `Bearer ${f.token}` } })).status).toBe(401);
  const connectionPath = f.connectionPath, adapterPath = join(f.home, ".config/opencode/plugins/dim-llm-router.js");
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const {default: plugin} = await import(process.env.DIM_TEST_ADAPTER);
    const hooks = await plugin();
    const config = { theme: "preserved", provider: { existing: { name: "keep" } } };
    await hooks.config(config);
    if (config.theme !== "preserved" || config.provider.existing.name !== "keep") throw Error("unrelated configuration changed");
    if (config.provider["dim-responses"].npm !== "@ai-sdk/openai") throw Error("wrong wire protocol");
    if (config.model !== "dim-responses/reviewed-model" || config.small_model !== config.model) throw Error("router was not selected by default");
    const generated={provider:{},agent:{Sisyphus:{model:"anthropic/paid",variant:"max"},custom:{prompt:"keep"}}};
    await hooks.config(generated);
    if(Object.values(generated.agent).some(agent=>agent.model!==config.model))throw Error("generated agent escaped router");
    if(generated.agent.custom.prompt!=="keep"||generated.agent.Sisyphus.variant!==undefined)throw Error("agent configuration damaged");
    const params={options:{store:true}};
    await hooks["chat.params"]({model:{providerID:"dim-responses",id:"reviewed-model"}},params);
    if(params.options.store!==false)throw Error("stateful Responses enabled");
    await hooks["chat.params"]({model:{providerID:"anthropic",id:"paid"}}).then(()=>{throw Error("paid fallback accepted")},()=>{});
    process.env.DIM_LLM_ROUTER_OPENCODE_MODE="providers";
    const independent=await plugin(),explicit={model:"user/model",small_model:"user/small",provider:{},agent:{custom:{model:"user/agent"}}};
    await independent.config(explicit);
    if(explicit.model!=="user/model"||explicit.small_model!=="user/small"||explicit.agent.custom.model!=="user/agent")throw Error("providers-only optout ignored");
    if (config.provider["dim-responses"].options.apiKey.length !== 43) throw Error("missing scoped token");
    await hooks.config(config).then(() => { throw Error("provider conflict accepted"); }, () => {});
    console.log("adapter-configured");
  `], { encoding: "utf8", env: { ...process.env, DIM_LLM_ROUTER_CONNECTION_FILE: connectionPath, DIM_TEST_ADAPTER: pathToFileURL(adapterPath).href } });
  expect(result.trim()).toBe("adapter-configured");
});
it("denies issuer scope escalation and keeps control-plane operator endpoints unreachable from the guest gateway", async () => {
  const f = await fixture(), scope = { bindingId: randomUUID(), workspaceId: f.workspace.id, workspaceName: f.workspace.name, projectId: "foreign", routeId: "default" };
  await expect(issuePrincipal(f.config.connection, scope, AbortSignal.timeout(5000))).rejects.toThrow(/403/);
  await expect(revokePrincipal(f.config.connection, scope, AbortSignal.timeout(5000))).rejects.toThrow(/403/);
  const response = await fetch(f.gatewayOrigin + "/v1/host-principals", { method: "POST", headers: { authorization: `Bearer ${f.token}` }, body: "{}" });
  expect(response.status).toBe(404);
});
it("fails closed for reused workspace names and aborts an active stream when its immutable workspace stops", async () => {
  const f = await fixture(true), response = await f.request(); expect(response.status).toBe(200);
  const reader = response.body!.getReader(); await reader.read();
  await f.store.write({ ...f.workspace, phase: "stopped" });
  await expect(reader.read()).rejects.toThrow();
  await vi.waitFor(() => expect(f.upstreamClosed()).toBe(true), { timeout: 5000 });
  await f.store.write({ ...f.workspace, id: "00000000-0000-0000-0000-000000000001" });
  expect((await f.request()).status).toBe(401);
});

it("separates issuer ownership and backs up/restores issuer keys without a host workspace root", async () => {
  const f = await fixture(), scope = { bindingId: randomUUID(), workspaceId: f.workspace.id, workspaceName: f.workspace.name, projectId: "application", routeId: "default" };
  const signal = AbortSignal.timeout(5000), first = await issuePrincipal(f.config.connection, scope, signal);
  const second = await issuePrincipal({ ...f.config.connection, issuerId: "host-b", issuerKeyFile: join(f.root, "issuer-b.key") }, scope, signal);
  expect(first.principalId).not.toBe(second.principalId);
  await revokePrincipal(f.config.connection, scope, signal);
  expect(f.cp.ledger.authenticate(first.token)).toBeUndefined();
  expect(f.cp.ledger.authenticate(second.token)?.projectId).toBe("application");
  await f.cp.close();
  const backup = join(f.root, "backup"); await backupRouter(f.cpConfig, backup);
  const restored = await loadConfig(await restoreRouter(backup, join(f.root, "restored")));
  expect(Object.keys(restored)).not.toContain("workspaceStateRoot");
  expect(await readFile(restored.hostIssuers[0]!.keyFile, "utf8")).toBe(f.issuerKey);
});
it("serializes principal rotation with workspace credential delivery", async () => {
  const f = await fixture();
  let deliver: ((status: number) => void) | undefined, entered: (() => void) | undefined;
  const delivery = new Promise<number>((resolve) => { deliver = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const execute = vi.mocked(f.context.service.exec).getMockImplementation();
  if (!execute) throw new Error("missing guest executor");
  let held = false;
  vi.mocked(f.context.service.exec).mockImplementation(async (...args) => {
    if (!held) { held = true; entered?.(); await delivery; }
    return execute(...args);
  });
  const args = ["llm", "attach", f.workspace.name, "--config", join(f.root, "host/gateway.json"), "--project", "application"];
  const first = runLlmCommand(args, f.context);
  await waiting;
  try { await expect(runLlmCommand(args, f.context)).rejects.toThrow(/another LLM attachment/); }
  finally { deliver?.(0); await first; }
});

it("replaces the current workspace binding across routes and aborts the obsolete local stream", async () => {
  const f = await fixture(true), response = await f.request(), reader = response.body!.getReader();
  await reader.read();
  await runLlmCommand(["llm", "attach", f.workspace.name, "--config", join(f.root, "host/gateway.json"), "--project", "application", "--route", "secondary"], f.context);
  const connection: unknown = JSON.parse(await readFile(f.connectionPath, "utf8"));
  if (typeof connection !== "object" || connection === null || !("token" in connection) || typeof connection.token !== "string") throw new Error("missing new token");
  expect(connection.token).not.toBe(f.token);
  expect((await f.request()).status).toBe(401);
  await expect(reader.read()).rejects.toThrow();
  expect((await fetch(f.gatewayOrigin + "/v1/models", { headers: { authorization: `Bearer ${connection.token}` } })).status).toBe(200);
  expect(Number(f.cp.ledger.database.prepare("SELECT COUNT(*) AS n FROM principals WHERE route_id='default' AND enabled=1").get()?.n)).toBe(0);
});
it("keeps the old binding usable when writing replacement helper assets fails before guest credential delivery", async () => {
  const f = await fixture(), launcher = join(f.home, ".config/dim/opencode-launch.js");
  await unlink(launcher); await symlink(join(f.root, "unused-symlink-target"), launcher);
  await expect(runLlmCommand(["llm", "attach", f.workspace.name, "--config", join(f.root, "host/gateway.json"), "--project", "application", "--route", "default"], f.context)).rejects.toThrow();
  const connection: unknown = JSON.parse(await readFile(f.connectionPath, "utf8"));
  expect(connection).toMatchObject({ token: f.token });
  const response = await f.request(); expect(response.status).toBe(200); await response.text();
  expect(Number(f.cp.ledger.database.prepare("SELECT COUNT(*) AS n FROM principals WHERE route_id='default' AND enabled=1").get()?.n)).toBe(1);
});

it("repairs attached helper assets automatically without changing credentials and reports actual gateway readiness", async () => {
  const f = await fixture(), before = await readFile(f.connectionPath, "utf8");
  const adapter = join(f.home, ".config/opencode/plugins/dim-llm-router.js"), launcher = join(f.home, ".config/dim/opencode-launch.js");
  await writeFile(adapter, "damaged asset", { mode: 0o600 }); await unlink(launcher);
  await hostPlugin.workspaceReady!(f.workspace, f.context);
  expect(await readFile(adapter, "utf8")).not.toBe("damaged asset");
  expect(await readFile(launcher, "utf8")).toContain("prepareOpenCode");
  expect(await readFile(f.connectionPath, "utf8")).toBe(before);
  expect(Number(f.cp.ledger.database.prepare("SELECT COUNT(*) AS n FROM principals").get()?.n)).toBe(1);
  expect(await hostPlugin.guest!.inspect!(f.workspace, f.context)).toMatchObject({ state: "ready" });
  await unlink(f.connectionPath); await unlink(adapter);
  await hostPlugin.workspaceReady!(f.workspace, f.context);
  await expect(readFile(adapter)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await hostPlugin.guest!.inspect!(f.workspace, f.context)).toMatchObject({ state: "unconfigured" });
});

it("honors an in-HOME XDG config root and rejects an outside-HOME replacement before committing credentials", async () => {
  const f = await fixture(), customConfig = join(f.home, "custom/config");
  f.guestEnvironment.XDG_CONFIG_HOME = customConfig;
  const attach = ["llm", "attach", f.workspace.name, "--config", join(f.root, "host/gateway.json"), "--project", "application"];
  await runLlmCommand(attach, f.context);
  const adapter = join(customConfig, "opencode/plugins/dim-llm-router.js");
  expect(await readFile(adapter, "utf8")).toContain("DimLlmRouter");
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const {default: factory}=await import(process.env.DIM_TEST_ADAPTER);
    const hook=await factory(),config={};await hook.config(config);
    if(config.model!=="dim-responses/reviewed-model")throw Error("custom XDG router not selected");
    console.log("custom-xdg-router-ready");
  `], { encoding: "utf8", env: { ...f.guestEnvironment, DIM_TEST_ADAPTER: pathToFileURL(adapter).href } });
  expect(result.trim()).toBe("custom-xdg-router-ready");
  expect(await hostPlugin.guest!.inspect!(f.workspace, f.context)).toMatchObject({ state: "ready" });
  const before = await readFile(f.connectionPath, "utf8"), connection: unknown = JSON.parse(before);
  if (!connection || typeof connection !== "object" || !("token" in connection) || typeof connection.token !== "string") throw new Error("missing attached token");
  f.guestEnvironment.XDG_CONFIG_HOME = join(f.root, "outside-home");
  await expect(runLlmCommand(attach, f.context)).rejects.toThrow(/inside workspace HOME/);
  expect(await readFile(f.connectionPath, "utf8")).toBe(before);
  expect((await fetch(f.gatewayOrigin + "/v1/models", { headers: { authorization: `Bearer ${connection.token}` } })).status).toBe(200);
  expect(await hostPlugin.guest!.inspect!(f.workspace, f.context)).toMatchObject({ state: "unconfigured" });
  expect(Number(f.cp.ledger.database.prepare("SELECT COUNT(*) AS n FROM principals WHERE enabled=1").get()?.n)).toBe(1);
});
