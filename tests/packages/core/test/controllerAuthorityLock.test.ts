import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredDimController,
  createDimController
} from "../../../../core/packages/core/src/controller.js";
import type { DimControllerOptions } from "../../../../core/packages/core/src/controller.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { DIM_PLUGIN_API_VERSION, registerPlugin } from "../../../../core/packages/core/src/plugin.js";
import { hostLifecycleOptions, hostRecord, workspaceRecord } from "./hostLifecycleFixture.js";

describe("controller workspace authority locking", () => {
  const servers: Server[] = [];
  const stateRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    await Promise.all(stateRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("serves setup host inputs while the workspace setup lock is held", async () => {
    // Given
    const root = await stateRoot();
    const state = new LifecycleState(root);
    const record = workspaceRecord("work", "setting-up");
    await state.claimWorkspace(record);
    await state.writeHostLifecycle(hostRecord("ready"));
    const grant = await state.ensureWorkspaceGrant(record.name);
    const plugin = await registerPlugin({
      name: "setup-input",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) {
        host.registerHostInputProvider("setup-input", { async resolve() { return "available"; } });
      }
    });
    const server = configuredDimController(hostLifecycleOptions(root), plugin);
    servers.push(server);
    await listen(server);
    const releaseSetup = await state.acquireWorkspaceSetupLock(record.name);

    try {
      // When
      const response = await fetch(`${baseUrl(server)}/api/host-inputs/setup-input`, {
        method: "POST",
        headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
        body: JSON.stringify({ key: "name" }),
        signal: AbortSignal.timeout(500)
      });

      // Then
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ value: "available" });
    } finally {
      await releaseSetup();
      await plugin.dispose();
    }
  });

  it("rejects an oversized body before entering the authority lease", async () => {
    // Given
    let authorityLeaseCount = 0;
    const runWorkspaceRequest: DimControllerOptions["runWorkspaceRequest"] = async (_workspace, operation) => {
      authorityLeaseCount += 1;
      return operation();
    };
    const server = createDimController({
      stateRoot: "/state",
      maxBodyBytes: 8,
      routes: [{
        method: "POST",
        path: "/bounded",
        summary: "Bounded body probe",
        audiences: ["agent"],
        handle: async ({ readJson }) => ({ body: await readJson() })
      }],
      authenticate: async () => ({ id: "id", name: "work", projectId: "pid", projectName: "project" }),
      runWorkspaceRequest,
      resolveTarget: vi.fn()
    });
    servers.push(server);
    await listen(server);

    // When
    const response = await fetch(`${baseUrl(server)}/api/bounded`, {
      method: "POST",
      headers: { authorization: "Bearer grant", "content-type": "application/json" },
      body: JSON.stringify({ value: "too large" })
    });

    // Then
    expect(response.status).toBe(400);
    expect(authorityLeaseCount).toBe(0);
  });

  async function stateRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "dim-controller-authority-"));
    stateRoots.push(root);
    return root;
  }
});

function listen(server: Server): Promise<void> {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => undefined);
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function address(server: Server): AddressInfo {
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("missing server address");
  return value;
}

function baseUrl(server: Server): string {
  return `http://127.0.0.1:${address(server).port}`;
}
