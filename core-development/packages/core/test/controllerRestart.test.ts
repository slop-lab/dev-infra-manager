import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredDimAgentController,
  configuredDimController,
  controllerRoutesForAudience,
  createDimController
} from "../../../../core/packages/core/src/controller.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { DIM_PLUGIN_API_VERSION, registerPlugin } from "../../../../core/packages/core/src/plugin.js";

describe("DIM controller", () => {
  const servers: ReturnType<typeof createDimController>[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
  });

it("accepts an asynchronous restart only for the authenticated workspace", async () => {
    const restartWorkspace = vi.fn(async () => undefined);
    const server = createDimController({
      stateRoot: "/state",
      authenticate: async (token) => token === "grant"
        ? { id: "project-id:work", name: "work", projectId: "project-id", projectName: "project" }
        : undefined,
      resolveTarget: vi.fn(),
      restartWorkspace,
      routes: []
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const endpoint = `http://127.0.0.1:${address.port}/api/workspace/restart`;

    expect((await fetch(endpoint, { method: "POST" })).status).toBe(401);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer grant" }
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, workspace: "work" });
    await vi.waitFor(() => expect(restartWorkspace).toHaveBeenCalledWith({
      id: "project-id:work",
      name: "work",
      projectId: "project-id",
      projectName: "project"
    }));

    const body = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer grant", "content-type": "application/json" },
      body: "{}"
    });
    expect(body.status).toBe(400);
  });
});
