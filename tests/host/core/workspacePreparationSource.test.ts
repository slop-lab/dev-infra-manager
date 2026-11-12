import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { WorkspaceService, WorkspaceStore, ProcessRunner, type WorkspaceRuntime } from "@slop-lab/dim-host-core/workspace";
import { ensureWorkspaceAgent } from "../../../packages/host/core/src/application/workspace-agent.js";
import { workspaceRecord } from "../../support/workspaceFixture.js";

it("records source-provider preparation failure before starting the scoped workspace agent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-source-preparation-")), plugins = path.join(root, "plugins");
  const store = new WorkspaceStore(path.join(root, "state")), original = workspaceRecord();
  const workspace = { ...original, source: { ...original.source, url: "fixture://selected" } };
  await store.write(workspace);
  const entry = path.join(plugins, "node_modules", "fixture"); await mkdir(entry, { recursive: true });
  await writeFile(path.join(plugins, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: ["fixture"] }));
  await writeFile(path.join(entry, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
  await writeFile(path.join(entry, "index.js"), 'export const hostPlugin={name:"fixture",source:{schemes:["fixture"],async create(){throw Error("unused")},async ensure(){throw Error("selected source connection unavailable")}}}');
  let guestExecutions = 0;
  const runtime: WorkspaceRuntime = { async inspect() { return { running: true }; }, async create() {}, async seed() {}, async start() {},
    async stop() { throw new Error("existing workload must not stop"); }, async remove() {}, async updateResources() { return { recreated: false }; },
    async exec(_record, command, options) {
      if (++guestExecutions !== 1) throw new Error("agent must not execute after failed source preparation");
      return runner.runStreaming(process.execPath, command.slice(1), options);
    }, async connect() { return 0; } };
  const service = new WorkspaceService(store, runtime, async () => { throw new Error("unused source acquisition"); }), runner = new ProcessRunner();
  vi.stubEnv("DIM_PLUGIN_HOME", plugins);
  try {
    await expect(ensureWorkspaceAgent(workspace, { store, service, runner, cleanupRunner: runner, runtime, stateRoot: store.root, signal: AbortSignal.timeout(2_000) }))
      .rejects.toThrow("selected source connection unavailable");
    expect(await store.read(workspace.name)).toMatchObject({ id: workspace.id, phase: "running", error: "Integration preparation failed: selected source connection unavailable" });
    expect(guestExecutions).toBe(1);
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
