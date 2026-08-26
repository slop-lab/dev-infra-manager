import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configuredDimAdminController } from "../../../../core/packages/core/src/adminController.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { LifecycleOptions } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { DIM_PLUGIN_API_VERSION, registerPlugin } from "../../../../core/packages/core/src/plugin.js";

describe("DIM admin controller", () => {
  const servers: ReturnType<typeof configuredDimAdminController>[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
  });

  it("reports health and dispatches plugin-owned admin routes", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-admin-controller-"));
    const plugins = await registerPlugin({
      name: "test.admin",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) {
        host.registerAdminRoute({
          method: "POST",
          path: "/test/:name",
          summary: "Test admin route",
          async handle(context) {
            if (context.params.name === "invalid") {
              const error = new Error("invalid plugin input");
              error.name = "UserError";
              throw error;
            }
            return { body: { name: context.params.name, input: await context.readJson() } };
          }
        });
      }
    });
    const server = configuredDimAdminController({ stateRoot } as LifecycleOptions, plugins);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const base = `http://127.0.0.1:${address.port}`;

    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({
      ok: true,
      ready: true,
      hostPhase: "ready",
      apiVersion: 1
    });
    const discovery = await fetch(`${base}/v1`);
    expect(await discovery.json()).toMatchObject({
      routes: [{ method: "POST", path: "/v1/test/:name", plugin: "test.admin" }]
    });
    const response = await fetch(`${base}/v1/test/item`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
    expect(await response.json()).toEqual({ name: "item", input: { enabled: true } });
    const invalid = await fetch(`${base}/v1/test/invalid`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid plugin input" });

    const started = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "workspace.exec", input: {} })
    });
    expect(started.status).toBe(202);
    const session = await started.json() as { id: string };
    const events = await fetch(`${base}/v1/sessions/${session.id}/events`);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    expect(await events.text()).toMatch(/event: error[\s\S]*name must be a string/);

    const rejected = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "plugin.unreviewed", input: {} })
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "operation 'plugin.unreviewed' is not streamable" });
    await new LifecycleState(stateRoot).writeHostLifecycle({
      schemaVersion: 1,
      phase: "stopped",
      resumeWorkspaces: ["work"],
      resumeCiRunners: [],
      resumeManagedContainers: [],
      updatedAt: new Date().toISOString()
    });
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({
      ok: true,
      ready: false,
      hostPhase: "stopped"
    });
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    await rm(stateRoot, { recursive: true, force: true });
    await plugins.dispose();
  });
});
