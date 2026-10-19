import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { atomicWrite } from "@slop-lab/dim-core";
import { ContainerWorkspaceRuntime, ProcessRunner, WorkspaceService, WorkspaceStore, type WorkspaceHostPluginContext } from "@slop-lab/dim-core/workspace";
import { hostPlugin } from "../../../../packages/host/plugins/mirrors/src/index.js";
import { findCacheEndpoints, readCacheEndpoints } from "../../../../packages/host/plugins/mirrors/src/provider.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";

it("skips unconfigured automatic attachment and reports connection configuration without provisioning or hiding malformed explicit configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-mirrors-discovery-")); vi.stubEnv("DIM_STATE_ROOT", root);
  try {
    const store = new WorkspaceStore(root), runner = new ProcessRunner();
    const service = new WorkspaceService(store, new ContainerWorkspaceRuntime(runner), async () => { throw new Error("unexpected repository acquisition"); });
    const execute = vi.spyOn(service, "exec").mockImplementation(async () => { throw new Error("unconfigured mirrors must not change the guest"); });
    const run = vi.spyOn(runner, "run").mockImplementation(async () => { throw new Error("cache discovery must not deploy servers"); });
    const context: WorkspaceHostPluginContext = { store, service, runner, cleanupRunner: runner, stateRoot: root, signal: new AbortController().signal };
    const workspace = workspaceRecord();
    expect(await findCacheEndpoints()).toBeUndefined();
    await expect(readCacheEndpoints()).rejects.toThrow(/cache URLs are not configured/);
    await hostPlugin.workspaceReady!(workspace, context);
    expect(await hostPlugin.guest!.inspect!(workspace, context)).toMatchObject({ state: "unconfigured" });
    expect(execute).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    const endpoints = { docker: "https://nas.example/docker/", npm: "https://npm.example/cache/", pypi: "https://nas.example/root/pypi/+simple/", apt: "http://mirror.example:3142/" };
    await atomicWrite(join(root, "services/package-caches.json"), { schemaVersion: 1, endpoints });
    const discovered = await hostPlugin.guest!.inspect!(workspace, context);
    expect(discovered).toMatchObject({ state: "ready", message: expect.stringContaining("does not probe cache health") });
    expect(JSON.stringify(discovered)).not.toContain("https://"); expect(JSON.stringify(discovered)).not.toContain("http://");
    await atomicWrite(join(root, "plugins/host-mirrors/config.json"), { schemaVersion: 99, endpoints });
    await expect(findCacheEndpoints()).rejects.toThrow(/schemaVersion/);
    await expect(hostPlugin.workspaceReady!(workspace, context)).rejects.toThrow(/schemaVersion/);
    await expect(hostPlugin.guest!.inspect!(workspace, context)).rejects.toThrow(/schemaVersion/);
    expect(execute).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
