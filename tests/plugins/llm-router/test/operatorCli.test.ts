import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runRouterCommand } from "../../../../packages/control-plane/plugins/llm-router/src/cli.js";
import { createRouter } from "../../../../packages/control-plane/plugins/llm-router/src/server.js";
import { RouterLedger } from "../../../../packages/control-plane/plugins/llm-router/src/ledger.js";
import { loadConfig } from "../../../../packages/control-plane/plugins/llm-router/src/config.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("operator commands manage project policy, admission pause and usage export", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-llm-operator-")); roots.push(root);
  const context = { signal: new AbortController().signal };
  const output: string[] = []; vi.spyOn(console, "log").mockImplementation((value: unknown) => { output.push(String(value)); });
  const directory = join(root, "operator");
  await runRouterCommand(["llm", "prepare", directory, "--backend", "http://127.0.0.1:8317", "--backend-key-file", join(root, "key"), "--exclusive-account-reference", "account", "--model", "reviewed", "--context-tokens", "10000", "--output-tokens", "1000"], context);
  const config = join(directory, "router.json"), call = (action: string, project = "application", extra: string[] = []) => runRouterCommand(["llm", action, project, "--config", config, ...extra], context);
  await call("project-add"); await call("pause"); await call("policy"); expect(JSON.parse(output.at(-1)!)).toMatchObject({ paused: true });
  await call("resume"); await call("disable"); await call("policy"); expect(JSON.parse(output.at(-1)!)).toMatchObject({ enabled: false });
  await call("enable"); await call("usage"); expect(JSON.parse(output.at(-1)!)).toMatchObject({ projectId: "application", requests: 0 });
  await call("usage-export", "application", ["--output", join(root, "usage.ndjson")]);
  expect(JSON.parse((await readFile(join(root, "usage.ndjson"), "utf8")).trim())).toMatchObject({ kind: "summary", projectId: "application" });
  await expect(call("project-add")).rejects.toThrow();
});

it("control-plane operator commands retrieve, expires, exports, backs up and restores actual HTTP exchanges", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-llm-operator-flow-")); roots.push(root);
  const workspace = workspaceRecord(), context = { signal: new AbortController().signal };
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
    const directory = join(root, "operator"); await runRouterCommand(["llm", "prepare", directory, "--backend", `http://127.0.0.1:${address.port}`, "--backend-key-file", key, "--exclusive-account-reference", "account", "--model", "reviewed-model", "--context-tokens", "10000", "--output-tokens", "1000"], context);
    const configPath = join(directory, "router.json"), config = await loadConfig(configPath);
    const call = (action: string, target: string, extra: string[] = []) => runRouterCommand(["llm", action, target, "--config", configPath, ...extra], context);
    await call("project-add", "application"); router = await createRouter(config); const token = router.ledger.issue(workspace, "default", "application");
    await new Promise<void>((resolve) => router!.server.listen(0, "127.0.0.1", resolve)); const bound = router.server.address(); if (!bound || typeof bound === "string") throw new Error("no router");
    const invoke = async () => { const response = await fetch(`http://127.0.0.1:${bound.port}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: '{"model":"reviewed-model","input":"<script>inert</script>"}' }); await response.text(); return response.headers.get("x-dim-request-id")!; };
    const first = await invoke();
    await call("capture", first, ["--output", join(root, "capture-export")]); expect(await readFile(join(root, "capture-export/request.body"), "utf8")).toContain("<script>inert</script>");
    await call("capture-delete", first); expect(router.ledger.request(first).capture_state).toBe("deleted");
    const second = await invoke(); await call("retention", "application", ["--before", "2030-01-01T00:00:00Z"]); expect(router.ledger.request(second).capture_state).toBe("expired");
    await call("usage-export", "application", ["--output", join(root, "usage.ndjson")]); expect((await readFile(join(root, "usage.ndjson"), "utf8")).trim().split("\n")).toHaveLength(3);
    await runRouterCommand(["llm", "health", configPath], context); expect(JSON.parse(output.at(-1)!)).toMatchObject([{ billableInferencePerformed: false }]); expect(inferenceCalls).toBe(2);
    await router.close(); await runRouterCommand(["llm", "backup", configPath, "--output", join(root, "backup")], context);
    expect(JSON.parse(await readFile(join(root, "backup/manifest.json"), "utf8")).backendCredentials).toEqual({ default: "external-not-included" });
    await runRouterCommand(["llm", "restore", join(root, "backup"), "--output", join(root, "restored")], context);
    const restored = await loadConfig(join(root, "restored/router.json")), ledger = new RouterLedger(restored.stateDirectory);
    try { expect(ledger.usage("application")).toMatchObject({ requests: 2, knownInputTokens: 8 }); expect(ledger.authenticate(token)?.projectId).toBe("application"); } finally { ledger.close(); }
    expect(inferenceCalls).toBe(2);
  } finally { await router?.close(); backend.closeAllConnections(); await new Promise<void>((resolve) => backend.close(() => resolve())); }
});
