import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDimController, registerPlugins, UserError } from "@slop-lab/dim-core";
import { LifecycleState } from "../../core/packages/core/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../core/packages/core/src/lifecycleTypes.js";
import { createExternalUrlsPlugin } from "../../plugin-external-urls/src/index.js";

describe("workspace instance route authority", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).reverse().map((operation) => operation()));
  });

  it("denies a request authenticated by a replaced instance and accepts the fresh grant", async () => {
    // Given
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-route-authority-"));
    cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
    const oldRecord = workspaceRecord("A".repeat(43));
    const newRecord = workspaceRecord("B".repeat(43));
    const state = new LifecycleState(stateRoot);
    await state.claimWorkspace(oldRecord);
    const staleGrant = await state.ensureWorkspaceGrant(oldRecord.name);
    const target = net.createServer((socket) => socket.pipe(socket));
    await listen(target);
    cleanup.push(() => close(target));
    const listenPort = await availablePort();
    const plugins = await registerPlugins([createExternalUrlsPlugin({
      ingresses: { tcp: {
        description: "TCP",
        scheme: "tcp",
        domain: "127.0.0.1",
        listenHost: "127.0.0.1",
        listenPort
      } }
    })]);
    cleanup.push(() => plugins.dispose());
    let authenticationObserved = () => {};
    const authenticationStarted = new Promise<void>((resolve) => { authenticationObserved = resolve; });
    let releaseAuthentication = () => {};
    const authenticationReleased = new Promise<void>((resolve) => { releaseAuthentication = resolve; });
    let gateFirstAuthentication = true;
    const controller = createDimController({
      stateRoot,
      routes: plugins.controllerRoutes,
      authenticate: async (token) => {
        const record = await state.authenticateWorkspaceGrant(token);
        if (gateFirstAuthentication) {
          gateFirstAuthentication = false;
          authenticationObserved();
          await authenticationReleased;
        }
        return record && {
          id: record.workspaceId,
          name: record.name,
          projectId: record.projectId,
          projectName: record.projectName
        };
      },
      runWorkspaceRequest: async (workspace, operation) => {
        const release = await state.acquireWorkspaceAuthorityLock(workspace.name);
        try {
          const record = await state.readWorkspace(workspace.name);
          if (record.workspaceId !== workspace.id || record.phase === "discarding") {
            throw new UserError("workspace authority is no longer active");
          }
          return await operation();
        } finally {
          await release();
        }
      },
      resolveTarget: async (_workspace, requested) => ({
        protocol: requested.protocol,
        host: "127.0.0.1",
        port: address(target).port,
        fingerprint: "target-generation"
      })
    });
    await listen(controller);
    cleanup.push(() => close(controller));
    const endpoint = `http://127.0.0.1:${address(controller).port}/api/urls`;

    // When: authentication observes the old instance before same-name replacement.
    const staleRequest = createRoute(endpoint, staleGrant);
    await authenticationStarted;
    await state.removeWorkspaceGrant(oldRecord);
    await state.writeWorkspace(newRecord);
    const freshGrant = await state.ensureWorkspaceGrant(newRecord.name);
    releaseAuthentication();

    // Then: stale dispatch cannot persist a route, while current authority can.
    expect((await staleRequest).status).toBe(400);
    await expect(exchange(listenPort, "stale")).rejects.toThrow();
    expect((await createRoute(endpoint, freshGrant)).status).toBe(201);
    await expect(exchange(listenPort, "fresh")).resolves.toBe("fresh");
  });
});

function createRoute(endpoint: string, grant: string): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
    body: JSON.stringify({ ingress: "tcp", target: { containers: [], port: 22, protocol: "tcp" } })
  });
}

function workspaceRecord(workspaceId: string): WorkspaceRecord {
  return {
    schemaVersion: 8,
    workspaceId,
    name: "work",
    projectId: "project",
    projectName: "project",
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    rootCommit: "a".repeat(40),
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
    gitBaseUrl: "http://dim-gitea:3000/project",
    hostAliases: {},
    projectManifestPath: "/run/dim/project.json",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z"
  };
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await listen(server);
  const port = address(server).port;
  await close(server);
  return port;
}

function listen(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function exchange(port: number, message: string): Promise<string> {
  const socket = new net.Socket();
  socket.connect(port, "127.0.0.1");
  await once(socket, "connect");
  return new Promise((resolve, reject) => {
    socket.once("data", (chunk) => resolve(String(chunk)));
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("connection closed without data")));
    socket.write(message);
  });
}

function address(server: net.Server): net.AddressInfo {
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("missing address");
  return value;
}
