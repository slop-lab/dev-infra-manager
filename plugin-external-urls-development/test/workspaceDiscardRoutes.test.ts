import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configuredDimAdminController, createDimController, registerPlugins } from "@slop-lab/dim-core";
import { LifecycleState } from "../../core/packages/core/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../core/packages/core/src/types.js";
import { hostLifecycleOptions } from "../../core-development/packages/core/test/hostLifecycleFixture.js";
import { createExternalUrlsPlugin } from "../../plugin-external-urls/src/index.js";

describe("authoritative workspace discard", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).reverse().map((operation) => operation()));
  });

  it("revokes plugin routes before removing a workspace without a controller grant", async () => {
    // Given: a persisted TCP route for a workspace whose controller grant is absent.
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-discard-routes-"));
    cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
    const record = workspaceRecord();
    const state = new LifecycleState(stateRoot);
    await state.claimWorkspace(record);
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
    const controller = createDimController({
      stateRoot,
      runWorkspaceRequest: async (_workspace, operation) => operation(),
      routes: plugins.controllerRoutes,
      authenticate: async () => ({
        id: record.workspaceId,
        name: record.name,
        projectId: record.projectId,
        projectName: record.projectName
      }),
      resolveTarget: async (_workspace, requested) => ({
        protocol: requested.protocol,
        host: "127.0.0.1",
        port: address(target).port,
        fingerprint: "target-generation"
      })
    });
    await listen(controller);
    cleanup.push(() => close(controller));
    const controllerBase = `http://127.0.0.1:${address(controller).port}`;
    expect((await fetch(`${controllerBase}/api/urls`, {
      method: "POST",
      headers: { authorization: "Bearer grant", "content-type": "application/json" },
      body: JSON.stringify({
        ingress: "tcp",
        target: { containers: ["parent", "leaf"], port: 22, protocol: "tcp" }
      })
    })).status).toBe(201);
    expect(await exchange(listenPort, "before-discard")).toBe("before-discard");

    // When: the authoritative admin API discards the workspace directly.
    const lifecycle = hostLifecycleOptions(stateRoot);
    const admin = configuredDimAdminController(lifecycle, plugins, new MissingResourceRunner(record));
    await listen(admin);
    cleanup.push(() => close(admin));
    const response = await fetch(`http://127.0.0.1:${address(admin).port}/v1/call/workspace.discard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: record.name, keepVolume: false })
    });

    // Then: route persistence and live listener ownership are gone before workspace state.
    expect(response.status).toBe(200);
    await expect(state.readWorkspace(record.name)).rejects.toThrow();
    await expect(exchange(listenPort, "after-discard")).rejects.toThrow();
  });
});

class MissingResourceRunner implements StreamingCommandRunner {
  constructor(private readonly workspace: WorkspaceRecord) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    const volume = args[0] === "volume";
    return {
      command,
      args,
      stdout: "",
      stderr: volume
        ? `Error: No such volume: ${this.workspace.dockerVolumeName}`
        : `Error: No such container: ${this.workspace.containerName}`,
      exitCode: 1
    };
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}

function workspaceRecord(): WorkspaceRecord {
  return {
    schemaVersion: 8,
    workspaceId: "A".repeat(43),
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
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z"
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
    let received = false;
    socket.once("data", (chunk) => {
      received = true;
      resolve(String(chunk));
    });
    socket.once("error", reject);
    socket.once("close", () => {
      if (!received) reject(new Error("connection closed without data"));
    });
    socket.write(message);
  });
}

function address(server: net.Server): net.AddressInfo {
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("missing address");
  return value;
}
