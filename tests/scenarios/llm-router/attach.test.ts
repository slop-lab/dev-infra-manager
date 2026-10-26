import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { workspaceServiceEndpoint } from "@slop-lab/dim-host-core/workspace";
import { backupRouter, restoreRouter } from "../../../packages/control-plane/plugins/llm-router/src/operator.js";
import { loadConfig } from "../../../packages/control-plane/plugins/llm-router/src/config.js";
import { issuePrincipal, revokePrincipal } from "../../../packages/host/plugins/llm-router/src/client.js";
import { lockWorkspaceGateway } from "../../../packages/host/plugins/llm-router/src/workspaceService.js";
import { fixture, runLlmCommand, hostPlugin } from "./attachmentFixture.js";
it("attaches a local-only guest credential and forwards through independently configured control-plane authority", async () => {
  const f = await fixture(), response = await f.request(); expect(response.status).toBe(200); await response.text();
  expect(f.seenAuthorization()).toBe(`Bearer ${f.backendKey}`);
  expect(f.cp.ledger.authenticate(f.token)).toBeUndefined();
  expect(JSON.stringify(f.connection)).not.toContain(f.backendKey); expect(JSON.stringify(f.connection)).not.toContain(f.issuerKey);
  expect((await fetch(f.cpOrigin + "/v1/models", { headers: { authorization: `Bearer ${f.token}` } })).status).toBe(401);
  expect(f.connection).not.toHaveProperty("defaultModel");
  expect(f.connection).not.toHaveProperty("models");
  const connectionPath = f.connectionPath, adapterPath = join(f.home, ".config/opencode/plugins/dim-llm-router.js");
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    const {default: plugin} = await import(process.env.DIM_TEST_ADAPTER);
    const hooks = await plugin();
    const config = { theme: "preserved", provider: { existing: { name: "keep" } } };
    await hooks.config(config);
    if (config.theme !== "preserved" || config.provider.existing.name !== "keep") throw Error("unrelated configuration changed");
    if (config.provider["dim-responses"].npm !== "@ai-sdk/openai") throw Error("wrong wire protocol");
    if (config.model !== undefined || config.small_model !== undefined) throw Error("routing must not select models");
    const generated={provider:{},agent:{Sisyphus:{model:"anthropic/paid",variant:"max"},custom:{prompt:"keep"}}};
    await hooks.config(generated);
    if(generated.agent.Sisyphus.model!=="anthropic/paid"||generated.agent.Sisyphus.variant!=="max"||generated.agent.custom.model!==undefined)throw Error("role model or variant changed");
    if(generated.agent.custom.prompt!=="keep")throw Error("agent configuration damaged");
    const params={options:{store:true}};
    await hooks["chat.params"]({model:{providerID:"dim-responses",id:"reviewed-model"}},params);
    if(params.options.store!==false)throw Error("stateful Responses enabled");
    await hooks["chat.params"]({model:{providerID:"anthropic",id:"paid"}});
    if(config.provider.openai.options.baseURL!==config.provider["dim-responses"].options.baseURL)throw Error("native OpenAI provider escaped router");
    process.env.DIM_LLM_ROUTER_OPENCODE_MODE="providers";
    const independent=await plugin(),explicit={model:"user/model",small_model:"user/small",provider:{},agent:{custom:{model:"user/agent"}}};
    await independent.config(explicit);
    if(explicit.model!=="user/model"||explicit.small_model!=="user/small"||explicit.agent.custom.model!=="user/agent")throw Error("providers-only optout ignored");
    if (config.provider["dim-responses"].options.apiKey.length !== 43) throw Error("missing scoped token");
    await hooks.config(config).then(() => { throw Error("provider conflict accepted"); }, () => {});
    console.log("adapter-configured");
  `], { encoding: "utf8", env: { ...f.guestEnvironment, DIM_LLM_ROUTER_CONNECTION_FILE: connectionPath, DIM_TEST_ADAPTER: pathToFileURL(adapterPath).href } });
  expect(result.stdout.trim()).toBe("adapter-configured");
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
  expect((await f.request()).status).toBe(410);
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
it("serializes attachment ownership across gateway configurations", async () => {
  const f = await fixture();
  const first = await lockWorkspaceGateway(f.workspace, f.context);
  expect(first).toBeDefined();
  try { expect(await lockWorkspaceGateway(f.workspace, f.context)).toBeUndefined(); }
  finally { await first?.release(); }
});
it("pins one gateway configuration per workspace and preserves the active attachment on rejection", async () => {
  const f = await fixture();
  const selected = join(f.context.stateRoot, "llm-services", `${f.workspace.id}.json`);
  expect(JSON.parse(await readFile(selected, "utf8"))).toMatchObject({
    schemaVersion: 1,
    configFile: join(f.root, "host/gateway.json"),
    gatewayStateDirectory: f.config.stateDirectory,
    workspaceStateRoot: f.context.store.root,
  });
  const other = join(f.root, "other-gateway.json");
  await writeFile(other, JSON.stringify({ ...f.config, stateDirectory: join(f.root, "other-state") }), { mode: 0o600 });

  await expect(runLlmCommand(["llm", "attach", f.workspace.name, "--config", other, "--project", "application"], f.context))
    .rejects.toThrow(/another LLM gateway configuration/);

  const connection: unknown = JSON.parse(await readFile(f.connectionPath, "utf8"));
  expect(connection).toMatchObject({ token: f.token });
  const response = await f.request(); expect(response.status).toBe(200); await response.text();
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
  const selection = join(f.context.stateRoot, "llm-services", `${f.workspace.id}.json`);
  await unlink(selection);
  await unlink(launcher); await symlink(join(f.root, "unused-symlink-target"), launcher);
  await expect(runLlmCommand(["llm", "attach", f.workspace.name, "--config", join(f.root, "host/gateway.json"), "--project", "application", "--route", "default"], f.context)).rejects.toThrow();
  await expect(readFile(selection)).rejects.toMatchObject({ code: "ENOENT" });
  const connection: unknown = JSON.parse(await readFile(f.connectionPath, "utf8"));
  expect(connection).toMatchObject({ token: f.token });
  const response = await f.request(); expect(response.status).toBe(200); await response.text();
  expect(Number(f.cp.ledger.database.prepare("SELECT COUNT(*) AS n FROM principals WHERE route_id='default' AND enabled=1").get()?.n)).toBe(1);
});

it("restores the prior guest credential and selection when activation fails after delivery", async () => {
  const f = await fixture(), selection = join(f.context.stateRoot, "llm-services", `${f.workspace.id}.json`);
  const before = await readFile(f.connectionPath, "utf8"), selected = await readFile(selection, "utf8");
  const current = join(f.config.stateDirectory, "attachments", `.current-${f.workspace.id}.json`), saved = `${current}.saved`;
  const execute = vi.mocked(f.context.service.exec).getMockImplementation();
  if (!execute) throw new Error("missing guest executor");
  let delivered = false;
  vi.mocked(f.context.service.exec).mockImplementation(async (name, args, options) => {
    if (!options?.stdin) return execute(name, args, options);
    const chunks: Buffer[] = []; for await (const chunk of options.stdin) chunks.push(Buffer.from(chunk));
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString());
    const code = await execute(name, args, { ...options, stdin: Readable.from(chunks) });
    if (payload && typeof payload === "object" && "name" in payload && payload.name === "llm-router-connection" && code === 0) {
      delivered = true; await rename(current, saved); await mkdir(current);
    }
    return code;
  });
  try {
    await expect(runLlmCommand(["llm", "attach", f.workspace.name, "--config", join(f.root, "host/gateway.json"), "--project", "application"], f.context)).rejects.toThrow();
    expect(delivered).toBe(true);
    expect(await readFile(f.connectionPath, "utf8")).toBe(before);
    expect(await readFile(selection, "utf8")).toBe(selected);
  } finally { if (delivered) { await rm(current, { recursive: true }); await rename(saved, current); } }
  const response = await f.request(); expect(response.status).toBe(200); await response.text();
});

it("keeps a legacy direct connection usable when replacement delivery fails after helper preparation", async () => {
  const f = await fixture(), selection = join(f.context.stateRoot, "llm-services", `${f.workspace.id}.json`);
  const legacy = JSON.stringify({ ...f.connection, endpoint: f.gatewayOrigin });
  await writeFile(f.connectionPath, legacy, { mode: 0o600 }); await unlink(selection);
  const execute = vi.mocked(f.context.service.exec).getMockImplementation();
  if (!execute) throw new Error("missing guest executor");
  let attempted = false;
  vi.mocked(f.context.service.exec).mockImplementation(async (name, args, options) => {
    if (!options?.stdin) return execute(name, args, options);
    const chunks: Buffer[] = []; for await (const chunk of options.stdin) chunks.push(Buffer.from(chunk));
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (payload && typeof payload === "object" && "name" in payload && payload.name === "llm-router-connection") { attempted = true; return 1; }
    return execute(name, args, { ...options, stdin: Readable.from(chunks) });
  });
  await expect(runLlmCommand(["llm", "attach", f.workspace.name, "--config", join(f.root, "host/gateway.json"), "--project", "application"], f.context)).rejects.toThrow();
  expect(attempted).toBe(true); expect(await readFile(f.connectionPath, "utf8")).toBe(legacy);
  await expect(readFile(selection)).rejects.toMatchObject({ code: "ENOENT" });
  const response = await fetch(`${f.gatewayOrigin}/v1/models`, { headers: { authorization: `Bearer ${f.token}` } });
  expect(response.status).toBe(200); await response.body?.cancel();
});

it("repairs attached helper assets automatically without changing credentials and reports actual gateway readiness", async () => {
  const f = await fixture(), legacy: unknown = JSON.parse(await readFile(f.connectionPath, "utf8"));
  if (!legacy || typeof legacy !== "object") throw new Error("missing legacy guest connection");
  const selection = join(f.context.stateRoot, "llm-services", `${f.workspace.id}.json`);
  await writeFile(f.connectionPath, JSON.stringify({ ...legacy, endpoint: f.gatewayOrigin }), { mode: 0o600 });
  const before = JSON.parse(await readFile(f.connectionPath, "utf8"));
  const adapter = join(f.home, ".config/opencode/plugins/dim-llm-router.js"), launcher = join(f.home, ".config/dim/opencode-launch.js");
  await writeFile(adapter, "damaged asset", { mode: 0o600 }); await unlink(launcher);
  await hostPlugin.workspaceReady!(f.workspace, f.context);
  expect(await readFile(adapter, "utf8")).not.toBe("damaged asset");
  expect(await readFile(launcher, "utf8")).toContain("prepareOpenCode");
  expect(JSON.parse(await readFile(f.connectionPath, "utf8"))).toEqual({ ...before, endpoint: workspaceServiceEndpoint("llm-router") });
  expect(JSON.parse(await readFile(selection, "utf8"))).toMatchObject({ schemaVersion: 1, gatewayStateDirectory: f.config.stateDirectory });
  expect(Number(f.cp.ledger.database.prepare("SELECT COUNT(*) AS n FROM principals").get()?.n)).toBe(1);
  expect(await hostPlugin.guest!.inspect!(f.workspace, f.context)).toMatchObject({ state: "ready" });
  await unlink(f.connectionPath); await unlink(adapter);
  await hostPlugin.workspaceReady!(f.workspace, f.context);
  await expect(readFile(adapter)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await hostPlugin.guest!.inspect!(f.workspace, f.context)).toMatchObject({ state: "unconfigured" });
});
it("fails helper recovery when the pinned gateway identity changes without replacing guest credentials", async () => {
  const f = await fixture(), before = await readFile(f.connectionPath, "utf8");
  const configFile = join(f.root, "host/gateway.json");
  await writeFile(configFile, JSON.stringify({ ...f.config, stateDirectory: join(f.root, "replacement-state") }), { mode: 0o600 });

  await expect(hostPlugin.workspaceReady!(f.workspace, f.context)).rejects.toThrow(/gateway identity changed/);

  expect(await readFile(f.connectionPath, "utf8")).toBe(before);
  const response = await f.request(); expect(response.status).toBe(200); await response.text();
});

it("honors an in-HOME XDG config root and rejects an outside-HOME replacement before committing credentials", async () => {
  const f = await fixture(), customConfig = join(f.home, "custom/config");
  f.guestEnvironment.XDG_CONFIG_HOME = customConfig;
  const attach = ["llm", "attach", f.workspace.name, "--config", join(f.root, "host/gateway.json"), "--project", "application"];
  await runLlmCommand(attach, f.context);
  const adapter = join(customConfig, "opencode/plugins/dim-llm-router.js");
  expect(await readFile(adapter, "utf8")).toContain("DimLlmRouter");
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    const {default: factory}=await import(process.env.DIM_TEST_ADAPTER);
    const hook=await factory(),config={};await hook.config(config);
    if(config.model!==undefined||!config.provider.openai)throw Error("custom XDG router must preserve model choice");
    console.log("custom-xdg-router-ready");
  `], { encoding: "utf8", env: { ...f.guestEnvironment, DIM_TEST_ADAPTER: pathToFileURL(adapter).href } });
  expect(result.stdout.trim()).toBe("custom-xdg-router-ready");
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

it("passes large requests through the host gateway without a hidden upload cap", async () => {
  const f = await fixture();
  const input = "x".repeat(17 * 1024 * 1024);
  const response = await fetch(f.gatewayOrigin + "/v1/responses", { method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "reviewed-model", input }) });
  expect(response.status).toBe(200); await response.text();
  expect(f.cp.ledger.request(response.headers.get("x-dim-request-id")!)).toMatchObject({ outcome: "completed" });
}, 20_000);
