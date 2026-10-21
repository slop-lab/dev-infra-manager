import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ContainerWorkspaceRuntime, ProcessRunner, WorkspaceService, WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { lifecycleOptions } from "@slop-lab/dim-host-core/controller";
import { invokeExternalUrlConsole } from "../../../../packages/host/plugins/external-urls/src/console.js";
import { ExternalUrlStore, type StoredUrl } from "../../../../packages/host/plugins/external-urls/src/routeStore.js";
import { workspaceRecord } from "../../../support/workspaceFixture.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture(run: (context: WorkspaceHostPluginContext, workspace: ReturnType<typeof workspaceRecord>, route: StoredUrl) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dim-route-console-"));
  try {
    const configuration = join(root, "external-urls.json");
    await writeFile(configuration, JSON.stringify({ schemaVersion: 1, dnsProviders: { private: { driver: "cloudflare", argument: "PRIVATE DNS CREDENTIAL" } },
      ingresses: { local: { driver: "http", description: "Local ingress", scheme: "http", argument: "PRIVATE CONNECTION FILE" } } }));
    vi.stubEnv("DIM_EXTERNAL_URL_CONFIG", configuration);
    vi.stubEnv("DIM_MANAGED_STATE_ROOT", join(root, "controller"));
    const workspace = workspaceRecord(), store = new WorkspaceStore(join(root, "workspace-host")); await store.write(workspace);
    const runner = new ProcessRunner(), service = new WorkspaceService(store, new ContainerWorkspaceRuntime(runner), async () => { throw Error("Unexpected acquisition"); });
    vi.spyOn(service, "show").mockResolvedValue({ ...workspace, runtimeStatus: "running" });
    const route: StoredUrl = { id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", workspace: workspace.name, workspaceId: workspace.id, ingress: "local",
      target: { containers: [], port: 4096, protocol: "http" }, route: { id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", ingress: "local", authority: "work-a-opencode.dev.test" },
      url: "http://work-a-opencode.dev.test/", approval: "pending", createdAt: new Date().toISOString() };
    await run({ service, store, runner, cleanupRunner: runner, stateRoot: store.root, signal: new AbortController().signal }, workspace, route);
  } finally { await rm(root, { recursive: true, force: true }); }
}

it("creates a named workspace route with an exact grant and returns its accepted receipt without a follow-up read", async () => fixture(async (context, workspace, route) => {
  const request = vi.fn(async () => ({ urls: [route] })), approve = vi.fn();
  const result = await invokeExternalUrlConsole("routes.create", { workspace: workspace.name, workspaceId: workspace.id, ingress: "local", name: "opencode", port: 4096 }, context, { request, approve });
  expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: workspace.id }), "/api/urls", { method: "POST", body: {
    ingress: "local", subdomain: expect.stringMatching(/^work-a-[a-f0-9]{16}--opencode$/), target: { containers: [], port: 4096, protocol: "http" }
  } }, context.signal);
  expect(result.routes).toEqual([{ id: route.id, ingress: "local", url: route.url, approval: "pending", port: 4096, containers: [], protocol: "http" }]);
  expect(approve).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain("PRIVATE");
}));

it("rejects stale identities and another workspace's route before reaching host admin approval", async () => fixture(async (context, workspace, route) => {
  const request = vi.fn(), approve = vi.fn();
  await expect(invokeExternalUrlConsole("routes.create", { workspace: workspace.name, workspaceId: "ffffffff-ffff-4fff-afff-ffffffffffff", ingress: "local", name: "opencode", port: 4096 }, context, { request, approve })).rejects.toThrow("replaced");
  await new ExternalUrlStore(lifecycleOptions().stateRoot).put({ ...route, workspaceId: "ffffffff-ffff-4fff-afff-ffffffffffff" });
  await expect(invokeExternalUrlConsole("routes.approve", { workspace: workspace.name, workspaceId: workspace.id, id: route.id }, context, { request, approve })).rejects.toThrow("outside");
  expect(request).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
}));

it("keeps approval explicit and revokes through the workspace grant without exposing provider arguments", async () => fixture(async (context, workspace, route) => {
  expect(context.stateRoot).not.toBe(lifecycleOptions().stateRoot);
  await new ExternalUrlStore(lifecycleOptions().stateRoot).put(route);
  const request = vi.fn(async () => ({})), approve = vi.fn(async () => ({ urls: [{ ...route, approval: "approved" }] }));
  const selection = { workspace: workspace.name, workspaceId: workspace.id, id: route.id };
  expect((await invokeExternalUrlConsole("routes.approve", selection, context, { request, approve })).routes[0]?.approval).toBe("approved");
  expect(approve).toHaveBeenCalledExactlyOnceWith(route.id);
  expect((await invokeExternalUrlConsole("routes.revoke", selection, context, { request, approve })).routes).toEqual([]);
  expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: workspace.id }), `/api/urls/${route.id}`, { method: "DELETE" }, context.signal);
}));
