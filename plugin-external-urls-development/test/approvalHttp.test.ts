import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  configuredDimAdminController,
  createDimController,
  LifecycleState,
  RecordingRunner,
  registerPlugins,
  type ControllerWorkspace,
  type LifecycleOptions,
  type WorkspaceRecord
} from "@slop-lab/dim-core";
import { createExternalUrlsPlugin } from "../../plugin-external-urls/src/index.js";

const workspace = { id: "A".repeat(43), name: "work", projectId: "project-id", projectName: "project" };
const foreign = { id: "B".repeat(43), name: "foreign", projectId: "project-id", projectName: "project" };
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => Promise.all(cleanup.splice(0).reverse().map((operation) => operation())).then(() => {}));

it("keeps an approval-required HTTP route pending until host approval and preserves exact approval across restart", async () => {
  // Given: a current workspace, an approval-required ingress, and a real HTTP target.
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-http-approval-"));
  cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
  await new LifecycleState(stateRoot).claimWorkspace(workspaceRecord(workspace));
  const upstream = http.createServer((_request, response) => response.end("approved-target"));
  await listen(upstream);
  cleanup.push(() => closeServer(upstream));
  const ingressPort = await availablePort();
  const targetPort = serverPort(upstream);
  const first = await startPlugin(stateRoot, ingressPort, targetPort);
  cleanup.push(() => first.close());

  // When: the workspace requests the route but neither it nor a foreign workspace has host authority.
  const created = await requestUrl(first.controllerBase, "workspace-grant");
  const pending = routeResponse(await created.json());
  const workspaceApproval = await fetch(`${first.controllerBase}/api/urls/${pending.id}/approve`, {
    method: "POST",
    headers: { authorization: "Bearer workspace-grant" }
  });
  const foreignRevoke = await fetch(`${first.controllerBase}/api/urls/${pending.id}`, {
    method: "DELETE",
    headers: { authorization: "Bearer foreign-grant" }
  });

  // Then: creation succeeds with redacted pending state and public traffic remains denied.
  expect(created.status).toBe(201);
  expect(pending).toMatchObject({ approval: "pending", url: "http://work--app.example.test/" });
  expect(pending.internalFields).toEqual([]);
  expect(workspaceApproval.status).toBe(404);
  expect(foreignRevoke.status).toBe(404);
  expect(await proxyRequest(ingressPort)).toEqual({ status: 404, body: '{"error":"external route not found"}\n' });

  await first.close();
  const pendingRestart = await startPlugin(stateRoot, ingressPort, targetPort, true);
  cleanup.push(() => pendingRestart.close());
  expect(await proxyRequest(ingressPort)).toEqual({ status: 404, body: '{"error":"external route not found"}\n' });

  // When: the host administrator approves the exact pending ID after restart.
  const approved = await adminAction(pendingRestart.adminBase, "url-approve", pending.id);

  // Then: only that target becomes reachable and approval is durable.
  expect(approved.status, await approved.clone().text()).toBe(200);
  expect(routeResponse(await approved.json()).approval).toBe("approved");
  expect(await proxyRequest(ingressPort)).toEqual({ status: 200, body: "approved-target" });
  const stored = await storedRecord(stateRoot, workspace.id);
  expect(stored.approval).toBe("approved");

  await pendingRestart.close();
  const restarted = await startPlugin(stateRoot, ingressPort, targetPort, true);
  cleanup.push(() => restarted.close());

  // Then: restart restores approval only for the same workspace instance and exact route tuple.
  expect(await proxyRequest(ingressPort)).toEqual({ status: 200, body: "approved-target" });

  // When: the host administrator revokes the route.
  const revoked = await adminAction(restarted.adminBase, "url-revoke", pending.id);

  // Then: revocation is visible, terminal for that ID, and immediately denies traffic.
  expect(revoked.status).toBe(200);
  expect(routeResponse(await revoked.json()).approval).toBe("revoked");
  expect(await proxyRequest(ingressPort)).toEqual({ status: 404, body: '{"error":"external route not found"}\n' });
  expect((await adminAction(restarted.adminBase, "url-approve", pending.id)).status).toBe(400);

  const replacement = await requestUrl(restarted.controllerBase, "workspace-grant");
  const replacementRoute = routeResponse(await replacement.json());
  expect(replacement.status).toBe(201);
  expect(replacementRoute.id).not.toBe(pending.id);
  expect(replacementRoute.approval).toBe("pending");

  await new LifecycleState(stateRoot).writeWorkspace(workspaceRecord({ ...workspace, id: foreign.id }));
  expect((await adminAction(restarted.adminBase, "url-approve", replacementRoute.id)).status).toBe(400);
});

async function startPlugin(stateRoot: string, ingressPort: number, targetPort: number, initialize = false) {
  const registered = await registerPlugins([createExternalUrlsPlugin({
    ingresses: { public: {
      description: "Approval-required HTTP",
      scheme: "http",
      domain: "example.test",
      listenHost: "127.0.0.1",
      listenPort: ingressPort,
      approvalRequired: true
    } }
  })]);
  const resolveTarget = async () => ({
    protocol: "http" as const,
    host: "127.0.0.1",
    port: targetPort,
    fingerprint: "target-generation"
  });
  if (initialize) {
    const runner = new RecordingRunner();
    const initializeRoute = registered.controllerRoutes.find((route) => route.initialize)?.initialize;
    if (initializeRoute === undefined) throw new Error("missing external URL initializer");
    await initializeRoute({
      stateRoot,
      runner: { run: runner.run.bind(runner), runStreaming: vi.fn(async () => 0) },
      listWorkspaces: async () => [workspace],
      runWorkspaceRequest: async (_workspace, operation) => operation(),
      resolveTarget: async () => resolveTarget()
    });
  }
  const controller = createDimController({
    stateRoot,
    routes: registered.controllerRoutes,
    authenticate: async (token) => token === "workspace-grant" ? workspace : token === "foreign-grant" ? foreign : undefined,
    runWorkspaceRequest: async (_workspace, operation) => operation(),
    resolveTarget
  });
  const admin = configuredDimAdminController({ stateRoot } as LifecycleOptions, registered);
  await Promise.all([listen(controller), listen(admin)]);
  let closed = false;
  return {
    controllerBase: `http://127.0.0.1:${serverPort(controller)}`,
    adminBase: `http://127.0.0.1:${serverPort(admin)}/v1/external-url`,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([closeServer(controller), closeServer(admin)]);
      await registered.dispose();
    }
  };
}

function requestUrl(base: string, grant: string): Promise<Response> {
  return fetch(`${base}/api/urls`, {
    method: "POST",
    headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
    body: JSON.stringify({
      ingress: "public",
      subdomain: "work--app",
      target: { containers: ["agent"], port: 8080, protocol: "http" }
    })
  });
}

function adminAction(base: string, action: string, id: string): Promise<Response> {
  return fetch(`${base}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id })
  });
}

function routeResponse(value: unknown): {
  readonly id: string;
  readonly url: string;
  readonly approval: string;
  readonly internalFields: readonly string[];
} {
  if (!value || typeof value !== "object" || !("urls" in value) || !Array.isArray(value.urls)) {
    throw new Error("expected external URL response");
  }
  const route = value.urls[0];
  if (!route || typeof route !== "object" || !("id" in route) || typeof route.id !== "string"
    || !("url" in route) || typeof route.url !== "string"
    || !("approval" in route) || typeof route.approval !== "string") {
    throw new Error("expected external URL route status");
  }
  return {
    id: route.id,
    url: route.url,
    approval: route.approval,
    internalFields: ["route", "workspaceId", "policyRevision"].filter((name) => name in route)
  };
}

async function storedRecord(stateRoot: string, workspaceId: string): Promise<{ readonly approval?: string }> {
  const directory = path.join(stateRoot, "plugins", "external-urls", Buffer.from(workspaceId).toString("base64url"));
  const name = (await readdir(directory)).find((candidate) => candidate.endsWith(".json"));
  if (name === undefined) throw new Error("missing stored route");
  return JSON.parse(await readFile(path.join(directory, name), "utf8")) as { readonly approval?: string };
}

async function proxyRequest(port: number): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      headers: { host: "work--app.example.test" }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 500,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function availablePort(): Promise<number> {
  const server = http.createServer();
  await listen(server);
  const port = serverPort(server);
  await closeServer(server);
  return port;
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function serverPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return address.port;
}

function workspaceRecord(value: ControllerWorkspace): WorkspaceRecord {
  return {
    schemaVersion: 8, workspaceId: value.id, name: value.name, projectId: value.projectId,
    projectName: value.projectName, rootRepositoryAlias: "root", rootRef: "refs/heads/main",
    rootCommit: "a".repeat(40), workspaceDataPath: "/var/lib/dim/workspace-data", phase: "ready", profiles: [],
    composeProjectName: `dim-${value.name}`, containerName: `dim-ws-${value.name}`, networkName: "dim-control",
    dockerVolumeName: `dim-ws-${value.name}-docker`, runtimeBackend: "sysbox", kvm: false,
    cpuCount: "2", memory: "4g", pidsLimit: "2048", routes: [], gitUserName: "Agent",
    gitUserEmail: "agent@example.invalid", gitBaseUrl: "http://git/project", hostAliases: {},
    projectManifestPath: "/run/dim/project.json", createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z"
  };
}
