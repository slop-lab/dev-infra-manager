import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "../../../../packages/host/core/src/workspace/store.js";
import { IncusMachines } from "../../../../packages/host/plugins/vm/src/incus.js";
import { PersistentVmService } from "../../../../packages/host/plugins/vm/src/store.js";
import { serveVmConsole } from "../../../../packages/host/plugins/vm/src/console.js";
import { config, FakeIncus, workspace } from "./fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function unusedPort(): Promise<number> {
  const server = createTcpServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing TCP address");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
async function closeServer(server: Server): Promise<void> { await new Promise<void>((resolve) => server.close(() => resolve())); }
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dim-vm-console-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets"); await mkdir(assets); await writeFile(path.join(assets, "main.js"), "export class SpiceMainConn {}\n");
  const socket = path.join(root, "incus.sock");
  const incus = createServer((incoming, response) => {
    expect(incoming.url).toContain("/console?project=dim");
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ metadata: { id: "11111111-1111-1111-1111-111111111111", metadata: { fds: { "0": "data-secret", control: "control-secret" } } } }));
  });
  const upstream = new WebSocketServer({ noServer: true });
  incus.on("upgrade", (incoming, connection, head) => upstream.handleUpgrade(incoming, connection, head, (client) => {
    if (incoming.url?.includes("secret=data-secret")) client.on("message", (data) => client.send(data));
  }));
  cleanup.push(async () => { for (const client of upstream.clients) client.terminate(); upstream.close(); await closeServer(incus); });
  incus.listen(socket); await once(incus, "listening");
  const store = new WorkspaceStore(root), runner = new FakeIncus();
  await store.write(workspace({ initialized: true, phase: "running" }));
  const machines = new IncusMachines({ ...config, incusSocket: socket }, runner, { apply: async () => {}, verify: async () => {} });
  const service = new PersistentVmService(root, machines, store);
  await service.create("desktop", "a".repeat(64), workspace().resources); await service.start("desktop");
  const token = await service.grant("desktop", "dev");
  const port = await unusedPort();
  const server = await serveVmConsole(service, { ...config, incusSocket: socket }, { token: "owner-token-".repeat(4), assets, host: "127.0.0.1", port });
  cleanup.push(() => closeServer(server));
  return { service, store, token, port, url: `http://127.0.0.1:${port}` };
}

describe("scoped browser SPICE console", () => {
  it("proxies binary data without exposing Incus secrets and closes a revoked live stream", async () => {
    const { service, token, url, port } = await fixture();
    const session = await fetch(`${url}/session`, { method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify({ vm: "desktop", token }) });
    expect(session.status).toBe(204);
    const cookie = session.headers.get("set-cookie"); expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Strict");
    const client = new WebSocket(`ws://127.0.0.1:${port}/stream/desktop`, "binary", { headers: { origin: url, cookie: cookie?.split(";")[0] ?? "" } });
    cleanup.push(async () => { client.terminate(); }); await once(client, "open");
    const response = once(client, "message"); client.send(Buffer.from([0x52, 0x45, 0x44, 0x51]));
    expect((await response)[0]).toEqual(Buffer.from([0x52, 0x45, 0x44, 0x51]));
    const state = await fetch(`${url}/state/desktop`, { headers: { authorization: `Bearer ${token}` } });
    expect(await state.text()).not.toMatch(/secret|token|incus/);
    const closed = once(client, "close"); await service.revoke("desktop", workspace().id); await closed;
  });
  it("rejects cross-origin login and ungranted VM access", async () => {
    const { token, url } = await fixture();
    const cross = await fetch(`${url}/session`, { method: "POST", headers: { origin: "http://attacker.invalid", "content-type": "application/json" }, body: JSON.stringify({ vm: "desktop", token }) });
    expect(cross.status).toBe(400);
    const denied = await fetch(`${url}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vm: "desktop", token: "wrong-token" }) });
    expect(denied.status).toBe(403);
    const state = await fetch(`${url}/state/desktop`); expect(state.status).toBe(403);
  });
});
