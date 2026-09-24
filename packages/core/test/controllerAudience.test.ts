import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredDimAgentController,
  configuredDimController,
  controllerRoutesForAudience,
  createDimController
} from "../../../../core/packages/core/src/controller.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { DIM_PLUGIN_API_VERSION, registerPlugin } from "../../../../core/packages/core/src/plugin.js";

describe("DIM controller", () => {
  const servers: ReturnType<typeof createDimController>[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
  });

it("exposes only routes explicitly assigned to an audience", () => {
    const route = (path: string, audiences: Array<"workspace" | "agent">) => ({
      method: "GET" as const,
      path,
      summary: path,
      audiences,
      async handle() {}
    });
    const routes = [
      route("/workspace", ["workspace"]),
      route("/agent", ["agent"]),
      route("/shared", ["workspace", "agent"])
    ];
    expect(controllerRoutesForAudience(routes, "workspace").map(({ path }) => path))
      .toEqual(["/workspace", "/shared"]);
    expect(controllerRoutesForAudience(routes, "agent").map(({ path }) => path))
      .toEqual(["/agent", "/shared"]);
  });

it("isolates agent grants and discovery from the workspace controller", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-agent-controller-"));
    const state = new LifecycleState(stateRoot);
    const now = new Date().toISOString();
    const record: WorkspaceRecord = {
      schemaVersion: 6,
      name: "work",
      projectId: "pid",
      projectName: "project",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      rootCommit: "a".repeat(40),
      rootSnapshotPath: "/state/assets/project-roots/pid/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      workspaceDataPath: "/var/lib/dim/workspace-data",
      phase: "ready",
      profiles: [],
      composeProjectName: "dim-work",
      containerName: "dim-ws-work",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-docker",
      runtimeBackend: "sysbox",
      kvm: false,
      cpuCount: "2",
      memory: "4g",
      pidsLimit: "2048",
      routes: [],
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
      gitBaseUrl: "http://dim-gitea:3000/dim-project",
      hostAliases: {},
      projectManifestPath: "/run/dim/project.json",
      createdAt: now,
      updatedAt: now
    };
    await state.claimWorkspace(record);
    const workspaceGrant = await state.ensureWorkspaceGrant(record.name);
    const agentGrant = await state.ensureAgentGrant(record.name);
    const plugins = await registerPlugin({
      name: "agent-routes",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) {
        host.registerControllerRoute({
          method: "GET",
          path: "/safe",
          summary: "agent safe",
          audiences: ["agent"],
          async handle() { return { body: { ok: true } }; }
        });
        host.registerHostInputProvider("secret", { async resolve() { return "secret"; } });
      }
    });
    const lifecycle = { stateRoot } as LifecycleOptions;
    const workspaceServer = configuredDimController(lifecycle, plugins);
    const agentServer = configuredDimAgentController(lifecycle, plugins);
    servers.push(workspaceServer, agentServer);
    workspaceServer.listen(0, "127.0.0.1");
    agentServer.listen(0, "127.0.0.1");
    await Promise.all([once(workspaceServer, "listening"), once(agentServer, "listening")]);
    const address = (server: typeof workspaceServer) => {
      const value = server.address();
      if (!value || typeof value === "string") throw new Error("missing address");
      return `http://127.0.0.1:${value.port}`;
    };
    const workspaceBase = address(workspaceServer);
    const agentBase = address(agentServer);
    expect((await fetch(`${workspaceBase}/api`, { headers: { authorization: `Bearer ${agentGrant}` } })).status).toBe(401);
    expect((await fetch(`${agentBase}/api`, { headers: { authorization: `Bearer ${workspaceGrant}` } })).status).toBe(401);
    const discovery = await (await fetch(`${agentBase}/api`, {
      headers: { authorization: `Bearer ${agentGrant}` }
    })).json() as { routes: Array<{ path: string }>; hostInputProviders: string[] };
    expect(discovery.routes.map(({ path }) => path)).toEqual(["/api/safe"]);
    expect(discovery.hostInputProviders).toEqual([]);
    expect((await fetch(`${agentBase}/api/workspace/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentGrant}` }
    })).status).toBe(404);
    for (const operation of ["project.purge", "repo.delete", "git.credentials"]) {
      expect((await fetch(`${agentBase}/v1/call/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer ${agentGrant}`, "content-type": "application/json" },
        body: "{}"
      })).status).toBe(404);
    }
    await plugins.dispose();
    await rm(stateRoot, { recursive: true, force: true });
  });
});
