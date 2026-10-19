import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceStore, WorkspaceService, ContainerWorkspaceRuntime, ProcessRunner, type WorkspaceHostPluginContext } from "@slop-lab/dim-core/workspace";
const { runLlmCommand } = await import(new URL("cli.js", process.env.DIM_TEST_ROUTER_DIST ?? new URL("../../../../plugin-llm-router/dist/", import.meta.url)).href) as typeof import("../../../../plugin-llm-router/src/cli.js");
import { RouterLedger } from "../../../../plugin-llm-router/src/ledger.js";
import { createRouter } from "../../../../plugin-llm-router/src/server.js";
import { loadConfig } from "../../../../plugin-llm-router/src/config.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("prepares private configuration and installs a self-contained OpenCode adapter containing only the workspace grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-llm-attach-")); roots.push(root);
  const home = join(root, "agent-home"); await mkdir(home);
  const store = new WorkspaceStore(join(root, "workspaces")), workspace = workspaceRecord(); await store.write(workspace);
  const runner = new ProcessRunner(), service = new WorkspaceService(store, new ContainerWorkspaceRuntime(runner), async () => { throw new Error("unexpected source acquisition"); });
  const context: WorkspaceHostPluginContext = { runner, cleanupRunner: runner, stateRoot: store.root, store, service, signal: new AbortController().signal };
  vi.spyOn(console, "log").mockImplementation(() => {});
  const prepared = join(root, "operator");
  const prepare = ["llm", "prepare", prepared, "--backend", "http://127.0.0.1:8317", "--backend-key-file", join(root, "upstream.key"),
    "--exclusive-account-reference", "operator-account", "--model", "reviewed-model", "--context-tokens", "10000", "--output-tokens", "1000"];
  await runLlmCommand(prepare, context);
  await expect(runLlmCommand(prepare, context)).rejects.toThrow();
  const configPath = join(prepared, "router.json"), config = await loadConfig(configPath);
  // Execute only the workspace-side script in a disposable home; no host Docker or user config is touched.
  vi.spyOn(service, "exec").mockImplementation(async (_name, command, options = {}) => {
    expect(options.workspaceId).toBe(workspace.id);
    return runner.runStreaming(command[0]!, command.slice(1), { ...options, env: { ...process.env, HOME: home } });
  });
  await runLlmCommand(["llm", "project-add", "application", "--config", configPath], context);
  await runLlmCommand(["llm", "attach", workspace.name, "--config", configPath, "--project", "application", "--endpoint", "http://172.20.0.1:8318"], context);
  const connectionPath = join(home, ".config/dim/llm-router.json");
  const connection: unknown = JSON.parse(await readFile(connectionPath, "utf8"));
  expect(connection).toMatchObject({ workspaceId: workspace.id, endpoint: "http://172.20.0.1:8318", models: [{ id: "reviewed-model" }] });
  const ledger = new RouterLedger(config.stateDirectory);
  try { expect(ledger.authenticate((connection as { token: string }).token)?.workspaceId).toBe(workspace.id); } finally { ledger.close(); }
  const adapterPath = join(home, ".config/opencode/plugins/dim-llm-router.js");
  expect(await readFile(adapterPath, "utf8")).not.toContain("upstream.key");
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
  await runLlmCommand(["llm", "principal-revoke", workspace.id, "--config", configPath], context);
  const revoked = new RouterLedger(config.stateDirectory);
  try { expect(revoked.authenticate((connection as { token: string }).token)).toBeUndefined(); } finally { revoked.close(); }
});

it("operator commands manage project policy, admission pause and usage export", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-llm-operator-")); roots.push(root);
  const store = new WorkspaceStore(join(root, "workspaces")), runner = new ProcessRunner();
  const service = new WorkspaceService(store, new ContainerWorkspaceRuntime(runner), async () => { throw new Error("unexpected acquisition"); });
  const context: WorkspaceHostPluginContext = { runner, cleanupRunner: runner, stateRoot: store.root, store, service, signal: new AbortController().signal };
  const output: string[] = []; vi.spyOn(console, "log").mockImplementation((value: unknown) => { output.push(String(value)); });
  const directory = join(root, "operator");
  await runLlmCommand(["llm", "prepare", directory, "--backend", "http://127.0.0.1:8317", "--backend-key-file", join(root, "key"), "--exclusive-account-reference", "account", "--model", "reviewed", "--context-tokens", "10000", "--output-tokens", "1000"], context);
  const config = join(directory, "router.json"), call = (action: string, project = "application", extra: string[] = []) => runLlmCommand(["llm", action, project, "--config", config, ...extra], context);
  await call("project-add"); await call("pause"); await call("policy"); expect(JSON.parse(output.at(-1)!)).toMatchObject({ paused: true });
  await call("resume"); await call("disable"); await call("policy"); expect(JSON.parse(output.at(-1)!)).toMatchObject({ enabled: false });
  await call("enable"); await call("usage"); expect(JSON.parse(output.at(-1)!)).toMatchObject({ projectId: "application", requests: 0 });
  await call("usage-export", "application", ["--output", join(root, "usage.ndjson")]);
  expect(JSON.parse((await readFile(join(root, "usage.ndjson"), "utf8")).trim())).toMatchObject({ kind: "summary", projectId: "application" });
  await expect(call("project-add")).rejects.toThrow();
});

it("compiled operator CLI retrieves, expires, exports, backs up and restores actual HTTP exchanges", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-llm-operator-flow-")); roots.push(root);
  const store = new WorkspaceStore(join(root, "workspaces")), workspace = workspaceRecord(); await store.write(workspace);
  const runner = new ProcessRunner(), service = new WorkspaceService(store, new ContainerWorkspaceRuntime(runner), async () => { throw new Error("unexpected acquisition"); });
  const context: WorkspaceHostPluginContext = { runner, cleanupRunner: runner, stateRoot: store.root, store, service, signal: new AbortController().signal };
  const output: string[] = []; vi.spyOn(console, "log").mockImplementation((value: unknown) => { output.push(String(value)); });
  let inferenceCalls = 0;
  const backend = createServer((request, response) => {
    if (request.url === "/v1/models") { response.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}'); return; }
    inferenceCalls++; response.writeHead(200, { "content-type": "application/json" }).end('{"status":"completed","model":"reviewed-model","usage":{"input_tokens":4,"output_tokens":2}}');
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve)); const address = backend.address(); if (!address || typeof address === "string") throw new Error("no backend");
  let router: Awaited<ReturnType<typeof createRouter>> | undefined;
  try {
    const key = join(root, "backend.key"); await writeFile(key, "private-backend-key", { mode: 0o600 });
    const directory = join(root, "operator"); await runLlmCommand(["llm", "prepare", directory, "--backend", `http://127.0.0.1:${address.port}`, "--backend-key-file", key, "--exclusive-account-reference", "account", "--model", "reviewed-model", "--context-tokens", "10000", "--output-tokens", "1000"], context);
    const configPath = join(directory, "router.json"), config = await loadConfig(configPath);
    const call = (action: string, target: string, extra: string[] = []) => runLlmCommand(["llm", action, target, "--config", configPath, ...extra], context);
    await call("project-add", "application"); router = await createRouter(config); const token = router.ledger.issue(workspace, "default", "application");
    await new Promise<void>((resolve) => router!.server.listen(0, "127.0.0.1", resolve)); const bound = router.server.address(); if (!bound || typeof bound === "string") throw new Error("no router");
    const invoke = async () => { const response = await fetch(`http://127.0.0.1:${bound.port}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: '{"model":"reviewed-model","input":"<script>inert</script>"}' }); await response.text(); return response.headers.get("x-dim-request-id")!; };
    const first = await invoke();
    await call("capture", first, ["--output", join(root, "capture-export")]); expect(await readFile(join(root, "capture-export/request.body"), "utf8")).toContain("<script>inert</script>");
    await call("capture-delete", first); expect(router.ledger.request(first).capture_state).toBe("deleted");
    const second = await invoke(); await call("retention", "application", ["--before", "2030-01-01T00:00:00Z"]); expect(router.ledger.request(second).capture_state).toBe("expired");
    await call("usage-export", "application", ["--output", join(root, "usage.ndjson")]); expect((await readFile(join(root, "usage.ndjson"), "utf8")).trim().split("\n")).toHaveLength(3);
    await runLlmCommand(["llm", "health", configPath], context); expect(JSON.parse(output.at(-1)!)).toMatchObject([{ billableInferencePerformed: false }]); expect(inferenceCalls).toBe(2);
    await router.close(); await runLlmCommand(["llm", "backup", configPath, "--output", join(root, "backup")], context);
    expect(JSON.parse(await readFile(join(root, "backup/manifest.json"), "utf8")).backendCredentials).toEqual({ default: "external-not-included" });
    await runLlmCommand(["llm", "restore", join(root, "backup"), "--output", join(root, "restored")], context);
    const restored = await loadConfig(join(root, "restored/router.json")), ledger = new RouterLedger(restored.stateDirectory);
    try { expect(ledger.usage("application")).toMatchObject({ requests: 2, knownInputTokens: 8 }); expect(ledger.authenticate(token)?.projectId).toBe("application"); } finally { ledger.close(); }
    expect(inferenceCalls).toBe(2);
  } finally { await router?.close(); backend.closeAllConnections(); await new Promise<void>((resolve) => backend.close(() => resolve())); }
});
