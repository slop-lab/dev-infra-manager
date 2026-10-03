import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredDimController,
  createDimController
} from "../../../../core/packages/core/src/controller.js";
import { startHost } from "../../../../core/packages/core/src/hostLifecycle.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { DIM_PLUGIN_API_VERSION, registerPlugin } from "../../../../core/packages/core/src/plugin.js";
import * as workspaceLifecycle from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { StatefulContainerRunner } from "./ciRunnerContainerRunner.js";
import { hostLifecycleOptions, hostRecord, workspaceRecord } from "./hostLifecycleFixture.js";

vi.mock("../../../../core/packages/core/src/gitea.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/gitea.js")>(),
  ensureGitea: vi.fn(async () => {})
}));

vi.mock("../../../../core/packages/core/src/registryCache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/registryCache.js")>(),
  ensureRegistryCache: vi.fn(async () => {})
}));

vi.mock("../../../../core/packages/core/src/aptCache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/aptCache.js")>(),
  ensureAptCache: vi.fn(async () => {})
}));

describe("host recovery controller admission", () => {
  const servers: ReturnType<typeof createDimController>[] = [];
  const stateRoots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(stateRoots.map((stateRoot) => rm(stateRoot, { recursive: true, force: true })));
    servers.length = 0;
    stateRoots.length = 0;
  });

  it("lets host start replay trusted setup through the workspace controller", async () => {
    // Given
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-host-recovery-controller-"));
    stateRoots.push(stateRoot);
    const state = new LifecycleState(stateRoot);
    const record = workspaceRecord("recovering", "setup-error");
    const unrelated = workspaceRecord("unrelated", "setting-up");
    await state.claimWorkspace(record);
    await state.claimWorkspace(unrelated);
    await state.writeHostLifecycle(hostRecord("stopped", {
      resumeWorkspaces: [record.name],
      restartCiRunners: []
    }));
    const grant = await state.ensureWorkspaceGrant(record.name);
    const unrelatedGrant = await state.ensureWorkspaceGrant(unrelated.name);
    const plugins = await registerPlugin({
      name: "recovery-input",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) {
        host.registerHostInputProvider("setup-input", { async resolve() { return "available"; } });
      }
    });
    const server = configuredDimController(hostLifecycleOptions(stateRoot), plugins);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const base = `http://127.0.0.1:${address.port}`;
    let setupResponseStatus: number | undefined;
    let ordinaryResponseStatus: number | undefined;
    let unrelatedResponseStatus: number | undefined;
    vi.spyOn(workspaceLifecycle, "showWorkspace").mockImplementation(async () => state.readWorkspace(record.name));
    vi.spyOn(workspaceLifecycle, "setupWorkspace").mockImplementation(async () => {
      const settingUp = { ...record, phase: "setting-up" as const };
      await state.writeWorkspace(settingUp);
      ordinaryResponseStatus = (await fetch(`${base}/api`)).status;
      unrelatedResponseStatus = (await fetch(`${base}/api`, {
        headers: { authorization: `Bearer ${unrelatedGrant}` }
      })).status;
      setupResponseStatus = (await fetch(`${base}/api/host-inputs/setup-input`, {
        method: "POST",
        headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
        body: JSON.stringify({ key: "name" })
      })).status;
      const ready = { ...settingUp, phase: "ready" as const };
      await state.writeWorkspace(ready);
      return ready;
    });

    // When
    const result = await startHost(new StatefulContainerRunner(), hostLifecycleOptions(stateRoot));

    // Then
    expect(setupResponseStatus).toBe(200);
    expect(ordinaryResponseStatus).toBe(503);
    expect(unrelatedResponseStatus).toBe(503);
    expect(result.phase).toBe("ready");
    await plugins.dispose();
  });
});
