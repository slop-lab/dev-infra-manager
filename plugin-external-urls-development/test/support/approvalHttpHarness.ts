import { readFile, readdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  configuredDimAdminController,
  createDimController,
  RecordingRunner,
  registerPlugins,
  type ControllerWorkspace,
  type LifecycleOptions,
  type WorkspaceRecord
} from "@slop-lab/dim-core";
import { vi } from "vitest";
import { createExternalUrlsPlugin } from "../../../plugin-external-urls/src/index.js";

export const workspace = { id: "A".repeat(43), name: "work", projectId: "project-id", projectName: "project" };
export const foreign = { id: "B".repeat(43), name: "foreign", projectId: "project-id", projectName: "project" };

interface ApprovalHttpPluginOptions {
  readonly stateRoot: string;
  readonly ingressPort: number;
  readonly targetPort: number;
  readonly initialize?: boolean;
  readonly scheme?: "http" | "https";
  readonly listenHost?: string;
  readonly publicPort?: number;
  readonly failInitializationResolution?: boolean;
  readonly approvalExposure?: {
    readonly listenHost: string;
    readonly listenPort: number;
  };
}

export async function startApprovalHttpPlugin(options: ApprovalHttpPluginOptions) {
  const {
    stateRoot,
    ingressPort,
    targetPort,
    initialize = false,
    scheme = "http",
    listenHost = "127.0.0.1",
    publicPort,
    failInitializationResolution = false,
    approvalExposure
  } = options;
  const registered = await registerPlugins([createExternalUrlsPlugin({
    ingresses: { public: {
      description: "Approval-required HTTP",
      scheme,
      domain: "example.test",
      listenHost,
      listenPort: ingressPort,
      ...(publicPort === undefined ? {} : { port: publicPort }),
      ...(approvalExposure === undefined ? {} : { approvalExposure }),
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
      resolveTarget: async () => {
        if (failInitializationResolution) throw new Error("injected first target resolution failure");
        return resolveTarget();
      }
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

export function requestUrl(base: string, grant: string): Promise<Response> {
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

export function adminAction(base: string, action: string, id: string): Promise<Response> {
  return fetch(`${base}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id })
  });
}

export function routeResponse(value: unknown): {
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

export async function storedApproval(stateRoot: string, workspaceId: string): Promise<string | undefined> {
  const directory = path.join(stateRoot, "plugins", "external-urls", Buffer.from(workspaceId).toString("base64url"));
  const name = (await readdir(directory)).find((candidate) => candidate.endsWith(".json"));
  if (name === undefined) throw new Error("missing stored route");
  const stored = JSON.parse(await readFile(path.join(directory, name), "utf8")) as { readonly approval?: string };
  return stored.approval;
}

export function proxyRequest(port: number): Promise<{ readonly status: number; readonly body: string }> {
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

export async function availablePort(): Promise<number> {
  const server = http.createServer();
  await listen(server);
  const selected = serverPort(server);
  await closeServer(server);
  return selected;
}

export function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export function serverPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return address.port;
}

export function workspaceRecord(value: ControllerWorkspace): WorkspaceRecord {
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
