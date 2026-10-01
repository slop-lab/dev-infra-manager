import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredDimAgentController,
  configuredDimController,
  controllerRoutesForAudience,
  createDimController,
  initializeControllerRoutes
} from "../../../../core/packages/core/src/controller.js";
import { UserError } from "../../../../core/packages/core/src/errors.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { DIM_PLUGIN_API_VERSION, registerPlugin } from "../../../../core/packages/core/src/plugin.js";
import { workspaceRecord } from "./hostLifecycleFixture.js";

describe("DIM controller", () => {
  const servers: ReturnType<typeof createDimController>[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
  });

it("authenticates, discovers plugin routes, dispatches parameters, and resolves workspace targets", async () => {
    const resolveTarget = vi.fn(async () => ({
      protocol: "tcp" as const,
      host: "workspace",
      port: 8080,
      fingerprint: "target-generation"
    }));
    const server = createDimController({
      stateRoot: "/state",
      runWorkspaceRequest: async (_workspace, operation) => operation(),
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
            protocol: "tcp"
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
      target: {
        protocol: "tcp",
        host: "workspace",
        port: 8080,
        fingerprint: "target-generation"
      }
    });
    expect(resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ name: "work" }),
      { containers: ["dev"], port: 8080, protocol: "tcp" },
      "container-dns"
    );
  });

it("resolves registered host inputs with authenticated workspace context", async () => {
    const resolve = vi.fn(async () => "Developer");
    const server = createDimController({
      stateRoot: "/state",
      runWorkspaceRequest: async (_workspace, operation) => operation(),
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

  it("revalidates an authenticated workspace before dispatch", async () => {
    // Given
    let releaseAuthentication = () => {};
    const authenticationReleased = new Promise<void>((resolve) => { releaseAuthentication = resolve; });
    let authenticationObserved = () => {};
    const authenticationStarted = new Promise<void>((resolve) => { authenticationObserved = resolve; });
    let active = true;
    const handle = vi.fn(async () => ({ status: 201 }));
    const server = createDimController({
      stateRoot: "/state",
      authenticate: async () => {
        authenticationObserved();
        await authenticationReleased;
        return { id: "instance", name: "work", projectId: "pid", projectName: "project" };
      },
      runWorkspaceRequest: async (_workspace, operation) => {
        if (!active) throw new UserError("workspace authority is no longer active");
        return operation();
      },
      resolveTarget: vi.fn(),
      routes: [{ method: "POST", path: "/mutation", summary: "Mutate", audiences: ["workspace"], handle }]
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");

    // When
    const responsePending = fetch(`http://127.0.0.1:${address.port}/api/mutation`, {
      method: "POST",
      headers: { authorization: "Bearer grant" }
    });
    await authenticationStarted;
    active = false;
    releaseAuthentication();
    const response = await responsePending;

    // Then
    expect(response.status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  it("excludes discarding workspaces from controller route restoration", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-controller-restore-"));
    const state = new LifecycleState(root);
    await state.claimWorkspace(workspaceRecord("discarding", "discarding"));
    const restored: string[] = [];
    const plugin = await registerPlugin({
      name: "test",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) {
        host.registerControllerRoute({
          method: "GET",
          path: "/restore",
          summary: "Restore",
          audiences: ["workspace"],
          initialize: async (runtime) => {
            restored.push(...(await runtime.listWorkspaces()).map(({ name }) => name));
          },
          handle: async () => ({ status: 204 })
        });
      }
    });

    // When
    await initializeControllerRoutes({ stateRoot: root, defaultWorkspaceBackend: "sysbox" } as LifecycleOptions, plugin, {
      run: async (command, args) => ({ command, args, stdout: "", stderr: "", exitCode: 0 }),
      runStreaming: async () => 0
    });

    // Then
    expect(restored).toEqual([]);
    await plugin.dispose();
    await rm(root, { recursive: true, force: true });
  });
});
