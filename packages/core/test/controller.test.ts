import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDimController } from "../src/controller.js";

describe("DIM controller", () => {
  const servers: ReturnType<typeof createDimController>[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
  });

  it("authenticates, discovers plugin routes, dispatches parameters, and resolves workspace targets", async () => {
    const resolveTarget = vi.fn(async () => ({ protocol: "http" as const, host: "workspace", port: 8080 }));
    const server = createDimController({
      stateRoot: "/state",
      authenticate: async (token) => token === "grant"
        ? { id: "id", name: "work", projectId: "pid", projectName: "project" }
        : undefined,
      resolveTarget,
      routes: [{
        method: "POST",
        path: "/things/:id",
        summary: "Test plugin route",
        plugin: "test",
        discovery: { ingresses: ["tailnet"] },
        async handle(context) {
          const body = await context.readJson() as { port: number };
          const target = await context.resolveTarget({
            containers: ["dev"],
            port: body.port,
            protocol: "http"
          }, "container-dns");
          return { status: 201, body: { id: context.params.id, target } };
        }
      }]
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const base = `http://127.0.0.1:${address.port}`;

    expect((await fetch(`${base}/api`)).status).toBe(401);
    const discovery = await fetch(`${base}/api`, { headers: { authorization: "Bearer grant" } });
    expect(await discovery.json()).toMatchObject({
      apiVersion: 1,
      routes: [{
        method: "POST",
        path: "/api/things/:id",
        plugin: "test",
        discovery: { ingresses: ["tailnet"] }
      }]
    });
    const created = await fetch(`${base}/api/things/item-1`, {
      method: "POST",
      headers: { authorization: "Bearer grant", "content-type": "application/json" },
      body: JSON.stringify({ port: 8080 })
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      id: "item-1",
      target: { protocol: "http", host: "workspace", port: 8080 }
    });
    expect(resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ name: "work" }),
      { containers: ["dev"], port: 8080, protocol: "http" },
      "container-dns"
    );
  });
});
