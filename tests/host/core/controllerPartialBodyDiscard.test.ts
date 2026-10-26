import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createDimController } from "../../../packages/host/core/src/controller/controller.js";
import { ControllerWorkspaces } from "../../../packages/host/core/src/controller/controllerWorkspace.js";
import { workspaceRecord } from "../../support/workspaceFixture.js";

test("an incomplete request holds no workspace lock and cannot dispatch after discard intent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-partial-plugin-"));
  const workspaces = new ControllerWorkspaces({ stateRoot: path.join(root, "managed") }, root);
  const record = workspaceRecord("work");
  await workspaces.store.write(record);
  const grant = await workspaces.ensureGrant(record.name);
  const handler = vi.fn(async () => ({ status: 204 }));
  let authenticated!: () => void;
  const authentication = new Promise<void>((resolve) => { authenticated = resolve; });
  const server = createDimController({
    stateRoot: root,
    routes: [{ method: "POST", path: "/partial", summary: "Probe", handle: handler }],
    authenticate: async (token) => { const value = await workspaces.authenticate(token); authenticated(); return value; },
    runWorkspaceRequest: (workspace, operation) => workspaces.run(workspace, operation),
    resolveTarget: vi.fn()
  });
  let socket: net.Socket | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    socket = net.connect(address.port, "127.0.0.1");
    await once(socket, "connect");
    let response = "";
    socket.setEncoding("utf8").on("data", (chunk) => { response += chunk; });
    const body = '{"value":"done"}';
    socket.write(`POST /api/partial HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${grant}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n{`);
    await authentication;
    await workspaces.store.withLock(record.name, async () => {
      await workspaces.store.write({ ...record, phase: "discarding" });
    });
    expect(handler).not.toHaveBeenCalled();
    expect(await workspaces.authenticate(grant)).toBeUndefined();
    const closed = once(socket, "close");
    socket.write(body.slice(1));
    await closed;
    expect(response).toMatch(/^HTTP\/1.1 400/);
    expect(handler).not.toHaveBeenCalled();
  } finally {
    socket?.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
