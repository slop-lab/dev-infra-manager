import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  configuredDimAdminController,
  createDimController,
  LifecycleState,
  registerPlugins,
  type ControllerWorkspace,
  type LifecycleOptions,
  type WorkspaceRecord
} from "@slop-lab/dim-core";
import { createExternalUrlsPlugin } from "../../plugin-external-urls/src/index.js";

const workspaces = [
  { id: "A".repeat(43), name: "work-a", projectId: "project-a-id", projectName: "alpha" },
  { id: "B".repeat(43), name: "work-b", projectId: "project-b-id", projectName: "beta" }
] satisfies readonly ControllerWorkspace[];

const close: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(close.splice(0).map((item) => item())).then(() => {}));

it("lists every current workspace route only through the bounded host admin action", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-host-url-list-"));
  close.push(() => rm(stateRoot, { recursive: true, force: true }));
  const state = new LifecycleState(stateRoot);
  await Promise.all(workspaces.map((workspace) => state.claimWorkspace(workspaceRecord(workspace))));
  const registered = await registerPlugins([createExternalUrlsPlugin({
    ingresses: {
      public: {
        description: "Public HTTP",
        scheme: "http",
        domain: "example.test",
        listenHost: "127.0.0.1",
        listenPort: await availablePort()
      }
    }
  })]);
  close.push(() => registered.dispose());
  const grants = new Map([["grant-a", workspaces[0]], ["grant-b", workspaces[1]]]);
  const controller = createDimController({
    stateRoot,
    routes: registered.controllerRoutes,
    authenticate: async (token) => grants.get(token),
    runWorkspaceRequest: async (_workspace, operation) => operation(),
    resolveTarget: async () => ({
      protocol: "http",
      host: "127.0.0.1",
      port: 30_000,
      fingerprint: "target"
    })
  });
  await listen(controller);
  close.push(() => closeServer(controller));
  const controllerBase = `http://127.0.0.1:${serverPort(controller)}`;

  for (const [index, grant] of ["grant-a", "grant-b"].entries()) {
    const workspace = workspaces[index];
    const created = await fetch(`${controllerBase}/api/urls`, {
      method: "POST",
      headers: { authorization: `Bearer ${grant}`, "content-type": "application/json" },
      body: JSON.stringify({
        ingress: "public",
        subdomain: `${workspace?.name}--app`,
        target: { containers: [], port: 3000 + index }
      })
    });
    expect(created.status).toBe(201);
  }

  const firstWorkspaceList = await fetch(`${controllerBase}/api/urls`, {
    headers: { authorization: "Bearer grant-a" }
  });
  const foreignAdminAttempt = await fetch(`${controllerBase}/v1/external-url/url-list`, {
    method: "POST",
    headers: { authorization: "Bearer grant-a", "content-type": "application/json" },
    body: "{}"
  });
  expect(firstWorkspaceList.status).toBe(200);
  expect((await firstWorkspaceList.json() as { urls: Array<{ workspace: string }> }).urls)
    .toEqual([expect.objectContaining({ workspace: "work-a" })]);
  expect(foreignAdminAttempt.status).toBe(404);

  const admin = configuredDimAdminController(
    { stateRoot } as LifecycleOptions,
    registered
  );
  await listen(admin);
  close.push(() => closeServer(admin));
  const response = await fetch(`http://127.0.0.1:${serverPort(admin)}/v1/external-url/url-list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });

  expect(response.status).toBe(200);
  const body = await response.json() as { urls: Array<Record<string, unknown>> };
  expect(body.urls).toHaveLength(2);
  expect(body.urls.map(({ project, workspace }) => ({ project, workspace }))).toEqual([
    { project: "alpha", workspace: "work-a" },
    { project: "beta", workspace: "work-b" }
  ]);
  for (const entry of body.urls) {
    expect(entry.approval).toBe("not-required");
    expect(entry).not.toHaveProperty("projectId");
    expect(entry).not.toHaveProperty("workspaceId");
    expect(entry).not.toHaveProperty("route");
    expect(entry).not.toHaveProperty("policyRevision");
    expect(entry).not.toHaveProperty("token");
  }
});

it("rejects a host route inventory above its fixed response bound", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-host-url-limit-"));
  close.push(() => rm(stateRoot, { recursive: true, force: true }));
  const workspace = workspaces[0];
  if (workspace === undefined) throw new Error("missing workspace fixture");
  await new LifecycleState(stateRoot).claimWorkspace(workspaceRecord(workspace));
  const directory = path.join(
    stateRoot,
    "plugins",
    "external-urls",
    Buffer.from(workspace.id).toString("base64url")
  );
  await mkdir(directory, { recursive: true });
  await Promise.all(Array.from({ length: 1_001 }, async (_, index) => {
    const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({
      id,
      workspace: workspace.name,
      workspaceId: workspace.id,
      ingress: "public",
      target: { containers: [], port: 3000, protocol: "http" },
      route: { id, ingress: "public", authority: `${workspace.name}--${index}.example.test` },
      url: `https://${workspace.name}--${index}.example.test/`,
      createdAt: "2026-10-01T00:00:00.000Z"
    }));
  }));
  const registered = await registerPlugins([createExternalUrlsPlugin({ ingresses: {} })]);
  close.push(() => registered.dispose());
  const admin = configuredDimAdminController({ stateRoot } as LifecycleOptions, registered);
  await listen(admin);
  close.push(() => closeServer(admin));

  const response = await fetch(`http://127.0.0.1:${serverPort(admin)}/v1/external-url/url-list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "host external URL listing exceeds its 1000-route limit" });
});

function workspaceRecord(workspace: ControllerWorkspace): WorkspaceRecord {
  return {
    schemaVersion: 8,
    workspaceId: workspace.id,
    name: workspace.name,
    projectId: workspace.projectId,
    projectName: workspace.projectName,
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    rootCommit: "a".repeat(40),
    workspaceDataPath: "/var/lib/dim/workspace-data",
    phase: "ready",
    profiles: [],
    composeProjectName: `dim-${workspace.name}`,
    containerName: `dim-ws-${workspace.name}`,
    networkName: "dim-gitea",
    dockerVolumeName: `dim-ws-${workspace.name}-docker`,
    runtimeBackend: "sysbox",
    kvm: false,
    cpuCount: "4",
    memory: "8g",
    pidsLimit: "2048",
    routes: [],
    gitUserName: "DIM Test",
    gitUserEmail: "dim@example.invalid",
    gitBaseUrl: "http://dim-gitea:3000/dim-example",
    hostAliases: {},
    projectManifestPath: "/run/dim/project.json",
    createdAt: "now",
    updatedAt: "now"
  };
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
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function serverPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return address.port;
}
