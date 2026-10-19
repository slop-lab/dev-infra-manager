import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDimController, registerPlugins, UserError, ControllerWorkspaces } from "@slop-lab/dim-managed";
import { WorkspaceStore } from "@slop-lab/dim-core/workspace";
import type { WorkspaceRecord } from "@slop-lab/dim-core/workspace";
import { createExternalUrlsPlugin } from "../../../../packages/host/plugins/external-urls/src/index.js";
import { workspaceRecord as coreWorkspaceRecord } from "../../../support/workspaceFixture.js";

describe("workspace instance route authority", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).reverse().map((operation) => operation()));
  });

  it("denies a request authenticated by a replaced instance and accepts the fresh grant", async () => {
    // Given
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-route-authority-"));
    cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
    vi.stubEnv("DIM_STATE_ROOT", stateRoot);
    const oldRecord = workspaceRecord("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const newRecord = workspaceRecord("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const state = new WorkspaceStore(stateRoot);
    await state.write(oldRecord);
    const authority = new ControllerWorkspaces({ stateRoot }, undefined, stateRoot);
    const staleGrant = await authority.ensureGrant(oldRecord.name);
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
    const replacementTarget = net.createServer((socket) => socket.on("data", (chunk) => socket.write(`replacement:${String(chunk)}`)));
    await listen(replacementTarget); cleanup.push(() => close(replacementTarget));
    let runtimeAvailable = true, targetPort = address(target).port;
    let authenticationObserved = () => {};
    const authenticationStarted = new Promise<void>((resolve) => { authenticationObserved = resolve; });
    let releaseAuthentication = () => {};
    const authenticationReleased = new Promise<void>((resolve) => { releaseAuthentication = resolve; });
    let gateFirstAuthentication = true;
    const controller = createDimController({
      stateRoot,
      routes: plugins.controllerRoutes,
      authenticate: async (token) => {
        const record = await authority.authenticate(token);
        if (gateFirstAuthentication) {
          gateFirstAuthentication = false;
          authenticationObserved();
          await authenticationReleased;
        }
        return record;
      },
      runWorkspaceRequest: (workspace, operation) => authority.run(workspace, operation),
      resolveTarget: async (_workspace, requested) => {
        if (!runtimeAvailable) throw new UserError("owned runtime disappeared");
        return ({
        protocol: requested.protocol,
        host: "127.0.0.1",
        port: targetPort,
        fingerprint: `target:${targetPort}`
      }); }
    });
    await listen(controller);
    cleanup.push(() => close(controller));
    const endpoint = `http://127.0.0.1:${address(controller).port}/api/urls`;

    // When: authentication observes the old instance before same-name replacement.
    const staleRequest = createRoute(endpoint, staleGrant);
    await authenticationStarted;
    await state.write(newRecord);
    const freshGrant = await authority.ensureGrant(newRecord.name);
    releaseAuthentication();

    // Then: stale dispatch cannot persist a route, while current authority can.
    expect((await staleRequest).status).toBe(400);
    await expect(exchange(listenPort, "stale")).rejects.toThrow();
    expect((await createRoute(endpoint, freshGrant)).status).toBe(201);
    await expect(exchange(listenPort, "fresh")).resolves.toBe("fresh");
    runtimeAvailable = false;
    // Core UUID stays current, but the cached endpoint could now belong to a foreign runtime.
    await expect(exchange(listenPort, "must not use cached IP")).rejects.toThrow();
    runtimeAvailable = true; targetPort = address(replacementTarget).port;
    await expect(exchange(listenPort, "new connection")).resolves.toBe("replacement:new connection");
    // Cached target IP and port stay identical; UUID replacement must still deny a new connection.
    await state.remove(newRecord.name);
    await state.write({ ...newRecord, id: "cccccccc-cccc-cccc-cccc-cccccccccccc" });
    await expect(exchange(listenPort, "must not reach reused target")).rejects.toThrow();
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
  return coreWorkspaceRecord("work-a", { id: workspaceId });
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
