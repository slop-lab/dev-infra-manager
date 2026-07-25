import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExternalUrlController,
  MemoryExternalUrlStore,
  type ExternalRouteProvider,
  type ExternalUrlProvider
} from "../src/externalUrls.js";

describe("external URL controller", () => {
  const servers: ReturnType<typeof createExternalUrlController>[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
  });

  it("authenticates the workspace, derives the upstream, and composes route and URL providers", async () => {
    const route: ExternalRouteProvider = {
      name: "reverse-proxy",
      provision: vi.fn(async ({ upstream }) => ({
        authority: `proxy.internal:${upstream.port}`,
        protocol: "http" as const,
        providerId: "route-1"
      })),
      revoke: vi.fn(async () => {})
    };
    const tailscale: ExternalUrlProvider = {
      name: "tailscale",
      publish: vi.fn(async ({ workspace, request }) => ({
        url: `https://${request.service}.${workspace.name}.machine.example.test`
      })),
      revoke: vi.fn(async () => {})
    };
    const server = createExternalUrlController({
      authenticate: async (token) => token === "grant"
        ? { id: "ws-id", name: "work", projectId: "project-id", projectName: "project" }
        : undefined,
      resolveUpstream: async (_workspace, request) => ({
        protocol: "http",
        host: "dim-ws-work",
        port: request.port
      }),
      routeProviders: new Map([[route.name, route]]),
      urlProviders: new Map([[tailscale.name, tailscale]]),
      store: new MemoryExternalUrlStore()
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const base = `http://127.0.0.1:${address.port}`;

    const unauthorized = await fetch(`${base}/api/external-urls/list`);
    expect(unauthorized.status).toBe(401);
    const created = await fetch(`${base}/api/external-urls/request`, {
      method: "POST",
      headers: { authorization: "Bearer grant", "content-type": "application/json" },
      body: JSON.stringify({ service: "web", port: 3000 })
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { urls: Array<{ id: string; url: string }> };
    expect(body.urls[0]?.url).toBe("https://web.work.machine.example.test/");
    expect(route.provision).toHaveBeenCalledWith(expect.objectContaining({
      upstream: { protocol: "http", host: "dim-ws-work", port: 3000 }
    }));

    const listed = await fetch(`${base}/api/external-urls/list`, {
      headers: { authorization: "Bearer grant" }
    });
    expect((await listed.json() as { urls: unknown[] }).urls).toHaveLength(1);
    const removed = await fetch(`${base}/api/external-urls/${body.urls[0]?.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer grant" }
    });
    expect(removed.status).toBe(204);
    expect(tailscale.revoke).toHaveBeenCalledOnce();
    expect(route.revoke).toHaveBeenCalledOnce();
  });
});
