import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceStore, WorkspaceService, ContainerWorkspaceRuntime, ProcessRunner, type WorkspaceHostPluginContext } from "@slop-lab/dim-core/workspace";
const { runLlmCommand } = await import(new URL("../../../../plugin-llm-router/dist/cli.js", import.meta.url).href) as typeof import("../../../../plugin-llm-router/src/cli.js");
import { RouterLedger } from "../../../../plugin-llm-router/src/ledger.js";
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
    "--model", "reviewed-model", "--context-tokens", "10000", "--output-tokens", "1000"];
  await runLlmCommand(prepare, context);
  await expect(runLlmCommand(prepare, context)).rejects.toThrow();
  const configPath = join(prepared, "router.json"), config = await loadConfig(configPath);
  // Execute only the workspace-side script in a disposable home; no host Docker or user config is touched.
  vi.spyOn(service, "exec").mockImplementation(async (_name, command, options = {}) => runner.runStreaming(command[0]!, command.slice(1), {
    ...options, env: { ...process.env, HOME: home }
  }));
  await runLlmCommand(["llm", "attach", workspace.name, "--config", configPath, "--endpoint", "http://172.20.0.1:8318"], context);
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
    if (config.provider["dim-responses"].options.apiKey.length !== 43) throw Error("missing scoped token");
    await hooks.config(config).then(() => { throw Error("provider conflict accepted"); }, () => {});
    console.log("adapter-configured");
  `], { encoding: "utf8", env: { ...process.env, DIM_LLM_ROUTER_CONNECTION_FILE: connectionPath, DIM_TEST_ADAPTER: pathToFileURL(adapterPath).href } });
  expect(result.trim()).toBe("adapter-configured");
  await runLlmCommand(["llm", "revoke", workspace.name, "--config", configPath], context);
  const revoked = new RouterLedger(config.stateDirectory);
  try { expect(revoked.authenticate((connection as { token: string }).token)).toBeUndefined(); } finally { revoked.close(); }
});
