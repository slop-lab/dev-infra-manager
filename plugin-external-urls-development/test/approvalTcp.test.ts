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
  RecordingRunner,
  registerPlugins,
  type WorkspaceRecord,
  type LifecycleOptions
} from "@slop-lab/dim-core";
import { vi } from "vitest";
import { workspaceRecord } from "../../core-development/packages/core/test/hostLifecycleFixture.js";
import { createExternalUrlsPlugin } from "../../plugin-external-urls/src/index.js";
import { ExternalUrlStore } from "../../plugin-external-urls/src/routeStore.js";

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
  const started = await startApprovalTcpPlugin({
    stateRoot,
    record,
    targetPort: serverPort(target),
    ingressPort,
    domain: "127.0.0.1"
  });
  cleanup.push(() => started.close());

  // When: the workspace creates the route.
  const created = await fetch(`http://127.0.0.1:${serverPort(started.controller)}/api/urls`, {
    method: "POST",
    headers: { authorization: "Bearer grant", "content-type": "application/json" },
    body: JSON.stringify({ ingress: "tcp", target: { containers: ["ssh"], port: 22, protocol: "tcp" } })
  });
  const pending = route(await created.json());

  // Then: the request succeeds but the listener closes traffic while pending.
  expect(created.status).toBe(201);
  expect(pending.approval).toBe("pending");
  expect(pending.permalink).toBeUndefined();
  await expect(exchange(ingressPort, "pending")).rejects.toThrow();

  // When: host administration approves and then revokes that exact route ID.
  const base = started.adminBase;
  expect((await adminAction(base, "url-approve", pending.id)).status).toBe(200);

  // Then: approval enables the exact target and revocation removes reachability again.
  expect(await exchange(ingressPort, "approved")).toBe("approved");
  expect((await adminAction(base, "url-revoke", pending.id)).status).toBe(200);
  await expect(exchange(ingressPort, "revoked")).rejects.toThrow();

  const replacementResponse = await requestUrl(started.controller, "tcp");
  const replacement = route(await replacementResponse.json());
  expect(replacement.approval).toBe("pending");
  expect((await adminAction(base, "url-approve", replacement.id)).status).toBe(200);
  expect(await exchange(ingressPort, "replacement")).toBe("replacement");
  const deleted = await fetch(
    `http://127.0.0.1:${serverPort(started.controller)}/api/urls/${replacement.id}`,
    { method: "DELETE", headers: { authorization: "Bearer grant" } }
  );
  expect(deleted.status).toBe(204);
  await expect(exchange(ingressPort, "deleted")).rejects.toThrow();
});

it("regenerates a pending TCP route when its public authority changes", async () => {
  // Given: an approved TCP route on its original public domain and listener port.
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-tcp-policy-drift-"));
  cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
  const record = workspaceRecord("work", "ready");
  await new LifecycleState(stateRoot).claimWorkspace(record);
  const target = net.createServer((socket) => socket.pipe(socket));
  await listen(target);
  cleanup.push(() => closeServer(target));
  const firstPort = await availablePort();
  const first = await startApprovalTcpPlugin({
    stateRoot,
    record,
    targetPort: serverPort(target),
    ingressPort: firstPort,
    domain: "old.example.test"
  });
  const created = route(await (await requestUrl(first.controller, "tcp")).json());
  expect((await adminAction(first.adminBase, "url-approve", created.id)).status).toBe(200);
  expect(await exchange(firstPort, "first")).toBe("first");
  const before = (await new ExternalUrlStore(stateRoot).list(record.workspaceId))[0];
  if (before === undefined) throw new Error("missing stored TCP route before drift");
  await first.close();

  // When: restart changes authority but its first target resolution fails.
  const secondPort = await availablePort();
  const restarted = await startApprovalTcpPlugin({
    stateRoot,
    record,
    targetPort: serverPort(target),
    ingressPort: secondPort,
    domain: "new.example.test",
    initialize: true,
    failInitializationResolution: true
  });
  cleanup.push(() => restarted.close());
  const afterFailure = (await new ExternalUrlStore(stateRoot).list(record.workspaceId))[0];
  if (afterFailure === undefined) throw new Error("missing stored TCP route after failed reconciliation");

  // Then: denial persists with the old revision and tuple, keeping retry eligibility.
  expect(afterFailure).toMatchObject({
    approval: "pending",
    policyRevision: before.policyRevision,
    url: before.url,
    route: { authority: before.route.authority, url: before.route.url }
  });

  // When: the next controller request resolves the target successfully.
  const returned = route(await (await requestUrl(restarted.controller, "tcp")).json());
  const stored = (await new ExternalUrlStore(stateRoot).list(record.workspaceId))[0];
  const inventory = route(await (await fetch(`${restarted.adminBase}/url-list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  })).json());

  // Then: every public view advances to the new authority while approval stays pending.
  expect(returned).toEqual({ id: created.id, approval: "pending", url: `tcp://new.example.test:${secondPort}` });
  expect(inventory).toEqual(returned);
  expect(stored?.policyRevision).not.toBe(before.policyRevision);
  expect(stored?.route.authority).toBe(`new.example.test:${secondPort}`);
  expect(stored?.url).toBe(returned.url);
  await expect(exchange(secondPort, "pending")).rejects.toThrow();
  expect((await adminAction(restarted.adminBase, "url-approve", created.id)).status).toBe(200);
  expect(await exchange(secondPort, "approved")).toBe("approved");
});

function requestUrl(controller: http.Server, ingress: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${serverPort(controller)}/api/urls`, {
    method: "POST",
    headers: { authorization: "Bearer grant", "content-type": "application/json" },
    body: JSON.stringify({ ingress, target: { containers: ["ssh"], port: 22, protocol: "tcp" } })
  });
}

function adminAction(base: string, action: string, id: string): Promise<Response> {
  return fetch(`${base}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id })
  });
}

function route(value: unknown): {
  readonly id: string;
  readonly approval: string;
  readonly url: string;
  readonly permalink?: string;
} {
  if (!value || typeof value !== "object" || !("urls" in value) || !Array.isArray(value.urls)) {
    throw new Error("expected external URL response");
  }
  const entry = value.urls[0];
  if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string"
    || !("approval" in entry) || typeof entry.approval !== "string"
    || !("url" in entry) || typeof entry.url !== "string") {
    throw new Error("expected external URL route status");
  }
  const permalink = "permalink" in entry && typeof entry.permalink === "string"
    ? entry.permalink
    : undefined;
  return { id: entry.id, approval: entry.approval, url: entry.url, ...(permalink === undefined ? {} : { permalink }) };
}

interface ApprovalTcpPluginOptions {
  readonly stateRoot: string;
  readonly record: WorkspaceRecord;
  readonly targetPort: number;
  readonly ingressPort: number;
  readonly domain: string;
  readonly initialize?: boolean;
  readonly failInitializationResolution?: boolean;
}

async function startApprovalTcpPlugin(options: ApprovalTcpPluginOptions) {
  const registered = await registerPlugins([createExternalUrlsPlugin({
    ingresses: { tcp: {
      description: "Approval-required TCP",
      scheme: "tcp",
      domain: options.domain,
      listenHost: "127.0.0.1",
      listenPort: options.ingressPort,
      approvalRequired: true
    } }
  })]);
  const workspace = {
    id: options.record.workspaceId,
    name: options.record.name,
    projectId: options.record.projectId,
    projectName: options.record.projectName
  };
  const resolveTarget = async () => ({
    protocol: "tcp" as const,
    host: "127.0.0.1",
    port: options.targetPort,
    fingerprint: "tcp-target"
  });
  if (options.initialize === true) {
    const initializeRoute = registered.controllerRoutes.find((candidate) => candidate.initialize)?.initialize;
    if (initializeRoute === undefined) throw new Error("missing external URL initializer");
    const runner = new RecordingRunner();
    await initializeRoute({
      stateRoot: options.stateRoot,
      runner: { run: runner.run.bind(runner), runStreaming: vi.fn(async () => 0) },
      listWorkspaces: async () => [workspace],
      runWorkspaceRequest: async (_workspace, operation) => operation(),
      resolveTarget: async () => {
        if (options.failInitializationResolution === true) {
          throw new Error("injected first target resolution failure");
        }
        return resolveTarget();
      }
    });
  }
  const controller = createDimController({
    stateRoot: options.stateRoot,
    routes: registered.controllerRoutes,
    authenticate: async () => workspace,
    runWorkspaceRequest: async (_workspace, operation) => operation(),
    resolveTarget
  });
  const admin = configuredDimAdminController({ stateRoot: options.stateRoot } as LifecycleOptions, registered);
  await Promise.all([listen(controller), listen(admin)]);
  let closed = false;
  return {
    controller,
    adminBase: `http://127.0.0.1:${serverPort(admin)}/v1/external-url`,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([closeServer(controller), closeServer(admin)]);
      await registered.dispose();
    }
  };
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
