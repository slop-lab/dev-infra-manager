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
      schemaVersion: 3,
      name: "work",
      projectId: "pid",
      projectName: "project",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      projectPath: "/workspace/project",
      phase: "ready",
      profiles: [],
      composeProjectName: "dim-work",
      containerName: "dim-ws-work",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-docker",
      runtimeBackend: "runc",
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
    await plugins.dispose();
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("authenticates, discovers plugin routes, dispatches parameters, and resolves workspace targets", async () => {
    const resolveTarget = vi.fn(async () => ({ protocol: "http" as const, host: "workspace", port: 8080 }));
    const server = createDimController({
      stateRoot: "/state",
      authenticate: async (token) => token === "grant"
        ? { id: "id", name: "work", projectId: "pid", projectName: "project" }
        : undefined,
      resolveTarget,
      routes: [{
        method: "POST",
        path: "/things/:id",
        summary: "Test plugin route",
        audiences: ["workspace"],
        plugin: "test",
        discovery: { ingresses: ["tailnet"] },
        async handle(context) {
          const body = await context.readJson() as { port: number };
          const target = await context.resolveTarget({
            containers: ["dev"],
            port: body.port,
            protocol: "http"
          }, "container-dns");
          return { status: 201, body: { id: context.params.id, target } };
        }
      }]
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const base = `http://127.0.0.1:${address.port}`;

    expect((await fetch(`${base}/api`)).status).toBe(401);
    const discovery = await fetch(`${base}/api`, { headers: { authorization: "Bearer grant" } });
    expect(await discovery.json()).toMatchObject({
      apiVersion: 1,
      routes: [{
        method: "POST",
        path: "/api/things/:id",
        plugin: "test",
        discovery: { ingresses: ["tailnet"] }
      }]
    });
    const created = await fetch(`${base}/api/things/item-1`, {
      method: "POST",
      headers: { authorization: "Bearer grant", "content-type": "application/json" },
      body: JSON.stringify({ port: 8080 })
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      id: "item-1",
      target: { protocol: "http", host: "workspace", port: 8080 }
    });
    expect(resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ name: "work" }),
      { containers: ["dev"], port: 8080, protocol: "http" },
      "container-dns"
    );
  });

  it("resolves registered host inputs with authenticated workspace context", async () => {
    const resolve = vi.fn(async () => "Developer");
    const server = createDimController({
      stateRoot: "/state",
      authenticate: async (token) => token === "grant"
        ? { id: "id", name: "work", projectId: "pid", projectName: "project" }
        : undefined,
      resolveTarget: vi.fn(),
      routes: [],
      hostInputProviders: new Map([["builtin.git-author", { resolve }]])
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/host-inputs/builtin.git-author`,
      {
        method: "POST",
        headers: { authorization: "Bearer grant", "content-type": "application/json" },
        body: JSON.stringify({ key: "name" })
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: "Developer" });
    expect(resolve).toHaveBeenCalledWith(
      { key: "name" },
      { projectId: "pid", projectName: "project", workspaceName: "work" }
    );
  });

  it("accepts an asynchronous restart only for the authenticated workspace", async () => {
    const restartWorkspace = vi.fn(async () => undefined);
    const server = createDimController({
      stateRoot: "/state",
      authenticate: async (token) => token === "grant"
        ? { id: "project-id:work", name: "work", projectId: "project-id", projectName: "project" }
        : undefined,
      resolveTarget: vi.fn(),
      restartWorkspace,
      routes: []
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const endpoint = `http://127.0.0.1:${address.port}/api/workspace/restart`;

    expect((await fetch(endpoint, { method: "POST" })).status).toBe(401);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer grant" }
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, workspace: "work" });
    await vi.waitFor(() => expect(restartWorkspace).toHaveBeenCalledWith({
      id: "project-id:work",
      name: "work",
      projectId: "project-id",
      projectName: "project"
    }));

    const body = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer grant", "content-type": "application/json" },
      body: "{}"
    });
    expect(body.status).toBe(400);
  });
});
