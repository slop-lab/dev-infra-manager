import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDimController } from "../../../../core/packages/core/src/controller.js";
import type { DimControllerOptions } from "../../../../core/packages/core/src/controller.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { discardWorkspace } from "../../../../core/packages/core/src/workspaceLifecycle.js";
import type { StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { hostLifecycleOptions, workspaceRecord } from "./hostLifecycleFixture.js";

describe("partial controller body discard ordering", () => {
  const servers: Server[] = [];
  const sockets: net.Socket[] = [];
  const stateRoots: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await Promise.all(servers.splice(0).map(close));
    await Promise.all(stateRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("publishes discard denial before an incomplete agent body enters authority", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-controller-partial-body-"));
    stateRoots.push(root);
    const state = new LifecycleState(root);
    const record = workspaceRecord("work", "ready");
    await state.claimWorkspace(record);
    const grant = await state.ensureAgentGrant(record.name);
    let authenticationObserved = () => {};
    const authenticated = new Promise<void>((resolve) => { authenticationObserved = resolve; });
    let authorityLeaseCount = 0;
    const runWorkspaceRequest: DimControllerOptions["runWorkspaceRequest"] = async (_workspace, operation) => {
      authorityLeaseCount += 1;
      return operation();
    };
    const server = createDimController({
      stateRoot: root,
      routes: [{
        method: "POST",
        path: "/partial",
        summary: "Partial body probe",
        audiences: ["agent"],
        handle: async ({ readJson }) => ({ body: await readJson() })
      }],
      authenticate: async (token) => {
        const authenticatedRecord = await state.authenticateAgentGrant(token);
        authenticationObserved();
        return authenticatedRecord && {
          id: authenticatedRecord.workspaceId,
          name: authenticatedRecord.name,
          projectId: authenticatedRecord.projectId,
          projectName: authenticatedRecord.projectName
        };
      },
      runWorkspaceRequest,
      resolveTarget: vi.fn()
    });
    servers.push(server);
    await listen(server);
    const socket = net.createConnection({ host: "127.0.0.1", port: address(server).port });
    sockets.push(socket);
    await once(socket, "connect");

    // When
    socket.write([
      "POST /api/partial HTTP/1.1",
      "Host: 127.0.0.1",
      `Authorization: Bearer ${grant}`,
      "Content-Type: application/json",
      "Content-Length: 64",
      "",
      "{"
    ].join("\r\n"));
    await authenticated;
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Then
    expect(authorityLeaseCount).toBe(0);
    await expect(discardWorkspace(emptyRunner(), hostLifecycleOptions(root), record.name, false, [{
      async beforeDiscard() { throw new Error("stop after durable denial"); }
    }])).rejects.toThrow("stop after durable denial");
    await expect(state.readWorkspace(record.name)).resolves.toMatchObject({ phase: "discarding" });
    await expect(state.authenticateAgentGrant(grant)).resolves.toBeUndefined();
  });
});

function emptyRunner(): StreamingCommandRunner {
  return {
    run: async (command, args) => ({ command, args, stdout: "", stderr: "", exitCode: 0 }),
    runStreaming: async () => 0
  };
}

function listen(server: Server): Promise<void> {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => undefined);
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function address(server: Server): net.AddressInfo {
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("missing server address");
  return value;
}
