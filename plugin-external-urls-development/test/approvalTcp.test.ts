import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  configuredDimAdminController,
  createDimController,
  LifecycleState,
  registerPlugins,
  type LifecycleOptions
} from "@slop-lab/dim-core";
import { workspaceRecord } from "../../core-development/packages/core/test/hostLifecycleFixture.js";
import { createExternalUrlsPlugin } from "../../plugin-external-urls/src/index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).reverse().map((operation) => operation())).then(() => {}));

it("gates an approval-required TCP listener until host approval and disconnects it on revocation", async () => {
  // Given: a real TCP target and an approval-required TCP ingress owned by one current workspace.
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-tcp-approval-"));
  cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
  const record = workspaceRecord("work", "ready");
  await new LifecycleState(stateRoot).claimWorkspace(record);
  const target = net.createServer((socket) => socket.pipe(socket));
  await listen(target);
  cleanup.push(() => closeServer(target));
  const ingressPort = await availablePort();
  const registered = await registerPlugins([createExternalUrlsPlugin({
    ingresses: { tcp: {
      description: "Approval-required TCP",
      scheme: "tcp",
      domain: "127.0.0.1",
      listenHost: "127.0.0.1",
      listenPort: ingressPort,
      approvalRequired: true
    } }
  })]);
  cleanup.push(() => registered.dispose());
  const workspace = {
    id: record.workspaceId,
    name: record.name,
    projectId: record.projectId,
    projectName: record.projectName
  };
  const controller = createDimController({
    stateRoot,
    routes: registered.controllerRoutes,
    authenticate: async () => workspace,
    runWorkspaceRequest: async (_workspace, operation) => operation(),
    resolveTarget: async () => ({
      protocol: "tcp",
      host: "127.0.0.1",
      port: serverPort(target),
      fingerprint: "tcp-target"
    })
  });
  const admin = configuredDimAdminController({ stateRoot } as LifecycleOptions, registered);
  await Promise.all([listen(controller), listen(admin)]);
  cleanup.push(() => Promise.all([closeServer(controller), closeServer(admin)]).then(() => {}));

  // When: the workspace creates the route.
  const created = await fetch(`http://127.0.0.1:${serverPort(controller)}/api/urls`, {
    method: "POST",
    headers: { authorization: "Bearer grant", "content-type": "application/json" },
    body: JSON.stringify({ ingress: "tcp", target: { containers: ["ssh"], port: 22, protocol: "tcp" } })
  });
  const pending = route(await created.json());

  // Then: the request succeeds but the listener closes traffic while pending.
  expect(created.status).toBe(201);
  expect(pending.approval).toBe("pending");
  await expect(exchange(ingressPort, "pending")).rejects.toThrow();

  // When: host administration approves and then revokes that exact route ID.
  const base = `http://127.0.0.1:${serverPort(admin)}/v1/external-url`;
  expect((await adminAction(base, "url-approve", pending.id)).status).toBe(200);

  // Then: approval enables the exact target and revocation removes reachability again.
  expect(await exchange(ingressPort, "approved")).toBe("approved");
  expect((await adminAction(base, "url-revoke", pending.id)).status).toBe(200);
  await expect(exchange(ingressPort, "revoked")).rejects.toThrow();
});

function adminAction(base: string, action: string, id: string): Promise<Response> {
  return fetch(`${base}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id })
  });
}

function route(value: unknown): { readonly id: string; readonly approval: string } {
  if (!value || typeof value !== "object" || !("urls" in value) || !Array.isArray(value.urls)) {
    throw new Error("expected external URL response");
  }
  const entry = value.urls[0];
  if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string"
    || !("approval" in entry) || typeof entry.approval !== "string") {
    throw new Error("expected external URL route status");
  }
  return { id: entry.id, approval: entry.approval };
}

async function exchange(port: number, message: string): Promise<string> {
  const socket = new net.Socket();
  socket.connect(port, "127.0.0.1");
  await once(socket, "connect");
  return new Promise((resolve, reject) => {
    let received = false;
    socket.once("data", (chunk) => {
      received = true;
      socket.destroy();
      resolve(String(chunk));
    });
    socket.once("error", reject);
    socket.once("close", () => {
      if (!received) reject(new Error("connection closed without data"));
    });
    socket.write(message);
  });
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await listen(server);
  const port = serverPort(server);
  await closeServer(server);
  return port;
}

function listen(server: net.Server | http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: net.Server | http.Server): Promise<void> {
  if (server instanceof http.Server) server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function serverPort(server: net.Server | http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return address.port;
}
