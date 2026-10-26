import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ProcessRunner } from "../../../packages/host/core/src/runner.js";
import { WorkspaceService, type WorkspaceRuntime } from "../../../packages/host/core/src/workspace/service.js";
import { WorkspaceStore } from "../../../packages/host/core/src/workspace/store.js";
import { createWorkspaceAgentServer } from "../../../packages/host/core/src/application/workspace-agent.js";
import { openWorkspaceServiceChannel } from "../../../packages/host/core/src/workspace/serviceChannel.js";
import { maintainWorkspaceServiceChannel } from "../../../packages/host/core/src/workspace/serviceChannelReconnect.js";
import { workspaceServiceCleanup } from "../../../packages/host/core/src/workspace/serviceChannelGuest.js";
import { workspaceRecord } from "../../support/workspaceFixture.js";

it.each(["restart", "recreate"] as const)("reconnects after guest-initiated %s while retaining the host operation lifetime", async (operation) => {
  const root = await mkdtemp(join(tmpdir(), "dim-channel-lifecycle-"));
  const store = new WorkspaceStore(root), runner = new ProcessRunner(), events = new EventEmitter(), controller = new AbortController();
  const record = workspaceRecord(), token = randomBytes(32).toString("base64url");
  let running = true, recreated = 0;
  const kill = async () => { expect(await runner.runStreaming("node", ["-e", workspaceServiceCleanup, "--", token])).toBe(0); running = false; };
  const runtime: WorkspaceRuntime = {
    inspect: async () => ({ running }), create: async () => { recreated++; }, start: async () => { running = true; },
    stop: kill, remove: kill, updateResources: async () => ({ recreated: false }), seed: async () => {}, connect: async () => 0,
    exec: (_record, command, options) => runner.runStreaming(command[0] ?? "node", command.slice(1), options),
  };
  const service = new WorkspaceService(store, runtime, async () => { throw new Error("source acquisition not allowed"); });
  await store.write(record);
  const server = createWorkspaceAgentServer({ workspaceId: record.id, workspaceName: record.name, stateRoot: root, host: "127.0.0.1", token, generation: "a".repeat(64) },
    { store, service, runtime, stateRoot: root, runner, cleanupRunner: runner, signal: controller.signal }, async () => { events.emit("reconciled"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener missing");
  const first = once(events, "ready");
  const maintained = maintainWorkspaceServiceChannel({ signal: controller.signal,
    open: () => openWorkspaceServiceChannel({ token, port: 0, signal: controller.signal,
      exec: (command, options) => runtime.exec(record, command, options),
      current: async () => (await store.read(record.name)).id === record.id && running,
      resolve: async (name) => name === "workspace" ? `http://127.0.0.1:${address.port}` : undefined }),
    ready: async (port) => { events.emit("ready", port); }, disconnected: () => {}, report: () => {},
  });
  try {
    const [port] = await first, next = once(events, "ready"), reconciled = once(events, "reconciled");
    const response = await fetch(`http://127.0.0.1:${port}/services/workspace/v1/${operation}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(202); await response.body?.cancel();
    await reconciled;
    const [newPort] = await next;
    const resources = await fetch(`http://127.0.0.1:${newPort}/services/workspace/v1/resources`, { headers: { authorization: `Bearer ${token}` } });
    expect(resources.status).toBe(200); await resources.body?.cancel();
    expect((await store.read(record.name)).id).toBe(record.id);
    expect(recreated).toBe(operation === "recreate" ? 1 : 0);
    expect(controller.signal.aborted).toBe(false);
  } finally {
    controller.abort(); await maintained; server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
