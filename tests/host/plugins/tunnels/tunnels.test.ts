import { createServer, connect, type Server } from "node:net";
import { createSocket } from "node:dgram";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { TunnelStore } from "../../../../packages/host/plugins/tunnels/src/store.js";
import { serveTunnels } from "../../../../packages/host/plugins/tunnels/src/server.js";
import { startGuest, parseGuestConfiguration } from "../../../../packages/host/plugins/tunnels/src/assets/guest.mjs";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address(); if (!value || typeof value === "string") throw new Error("no port"); return value.port;
}
async function unusedPort() { const server = createServer(); const port = await listen(server); await new Promise<void>((resolve) => server.close(() => resolve())); return port; }
async function binaryRequest(port: number, data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true }); const chunks: Buffer[] = [];
    socket.once("error", reject); socket.setTimeout(2500, () => socket.destroy(new Error("response timeout")));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk)); socket.once("end", () => resolve(Buffer.concat(chunks))); socket.once("close", () => resolve(Buffer.concat(chunks)));
    socket.once("connect", () => socket.end(data));
  });
}
const token = "a".repeat(43), secondToken = "b".repeat(43);
it("persistent TCP and UDP routes preserve binary/FIN, enforce UUID and revoke existing streams", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dim-tunnels-"));
  const store = new TunnelStore(path.join(directory, "private.json"));
  const target = createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = [];
    socket.on("error", () => {}); socket.on("data", (data: Buffer) => chunks.push(data));
    socket.on("end", () => setTimeout(() => socket.end(Buffer.concat(chunks).reverse()), 30));
  });
  const udpTarget = createSocket("udp4");
  udpTarget.on("message", (message, peer) => udpTarget.send(Buffer.concat([Buffer.from([0xff]), message]), peer.port, peer.address));
  let relay: Awaited<ReturnType<typeof serveTunnels>> | undefined, guest: Awaited<ReturnType<typeof startGuest>> | undefined;
  let workspaceId = "uuid-one";
  const authority = { async current(grant: { workspaceId: string }) { return grant.workspaceId === workspaceId; } };
  try {
    const targetPort = await listen(target);
    await new Promise<void>((resolve) => udpTarget.bind(0, "127.0.0.1", resolve)); const udpPort = udpTarget.address().port;
    await store.initialize("operator");
    await store.update((value) => {
      value.routes.database = { protocol: "tcp", host: "127.0.0.1", port: targetPort };
      value.routes.dns = { protocol: "udp", host: "127.0.0.1", port: udpPort };
      value.grants[token] = { workspaceId, workspaceName: "dev", route: "database", localPort: 5555 };
      value.grants[secondToken] = { workspaceId, workspaceName: "dev", route: "dns", localPort: 5556 };
    });
    relay = await serveTunnels(store, authority, { relayHost: "127.0.0.1", relayPort: 0, operatorPort: 0 });
    const localTcp = await unusedPort(), localUdp = await unusedPort();
    const configuration = parseGuestConfiguration({ schemaVersion: 1, endpoint: `127.0.0.1:${relay.relayPort}`, tunnels: [
      { name: "database", protocol: "tcp", localPort: localTcp, token }, { name: "dns", protocol: "udp", localPort: localUdp, token: secondToken }
    ] });
    guest = await startGuest(configuration);
    const bytes = Buffer.from([0, 1, 255, 128, 10, 13]);
    expect(await binaryRequest(localTcp, bytes).catch((error: unknown) => { throw new Error("binary request failed", {cause:error}); })).toEqual(Buffer.from(bytes).reverse());
    const peer = createSocket("udp4");
    try {
      const response = new Promise<Buffer>((resolve) => peer.once("message", resolve));
      peer.send(bytes, localUdp, "127.0.0.1"); expect(await response).toEqual(Buffer.concat([Buffer.from([255]), bytes]));
    } finally { peer.close(); }
    // Same process restart reloads durable definitions and grants without re-attaching the guest.
    const relayPort = relay.relayPort; await relay.close();
    relay = await serveTunnels(store, authority, { relayHost: "127.0.0.1", relayPort, operatorPort: 0 });
    expect(await binaryRequest(localTcp, bytes).catch((error: unknown) => { throw new Error("post-restart request failed", {cause:error}); })).toEqual(Buffer.from(bytes).reverse());
    const held = connect({ host: "127.0.0.1", port: relayPort });
    held.on("error", () => {}); held.write(`${JSON.stringify({ token })}\n`);
    await new Promise<void>((resolve) => held.once("data", () => resolve()));
    const closed = new Promise<void>((resolve) => held.once("close", () => resolve()));
    workspaceId = "uuid-two"; // display name and target IP/port stay the same.
    await closed;
    expect(await binaryRequest(localTcp, bytes).catch((error: unknown) => { throw new Error("reused UUID request failed", {cause:error}); })).toEqual(Buffer.alloc(0));
    workspaceId = "uuid-one";
    expect(await binaryRequest(localTcp, bytes)).toEqual(Buffer.from(bytes).reverse());
    await store.update((value) => { delete value.grants[token]; });
    expect(await binaryRequest(localTcp, bytes)).toEqual(Buffer.alloc(0));
  } finally { guest?.close(); await relay?.close(); udpTarget.close(); await new Promise<void>((resolve) => target.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

it("operator UI requires private credentials and rejects cross-origin or non-JSON mutations", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dim-tunnel-admin-"));
  const store = new TunnelStore(path.join(directory, "private.json"));
  let server: Awaited<ReturnType<typeof serveTunnels>> | undefined;
  try {
    await store.initialize("operator"); const config = await store.read();
    server = await serveTunnels(store, { async current() { return true; } }, { relayHost: "127.0.0.1", relayPort: 0, operatorPort: 0 });
    const url = `http://127.0.0.1:${server.operatorPort}`, authorization = `Basic ${Buffer.from(`operator:${config.operator.password}`).toString("base64")}`;
    expect((await fetch(url)).status).toBe(401);
    const html = await fetch(url, { headers: { authorization } }); expect(html.status).toBe(200); expect(await html.text()).toContain("Workspace tunnels");
    const body = JSON.stringify({ name: "database", protocol: "tcp", host: "127.0.0.1", port: 5432 });
    expect((await fetch(`${url}/v1/routes`, { method: "POST", headers: { authorization, "content-type": "application/json", origin: "https://attacker.example" }, body })).status).toBe(403);
    expect((await fetch(`${url}/v1/routes`, { method: "POST", headers: { authorization, "content-type": "text/plain" }, body })).status).toBe(403);
    expect((await fetch(`${url}/v1/routes`, { method: "POST", headers: { authorization, "content-type": "application/json", origin: url }, body })).status).toBe(200);
    expect((await store.read()).routes.database?.port).toBe(5432);
    expect((await fetch(`${url}/v1/routes/database`, { method: "DELETE", headers: { authorization, "content-type": "application/json", origin: url } })).status).toBe(200);
    expect((await store.read()).routes).toEqual({});
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
});

it("failed guest listener startup releases ports opened earlier in the same startup", async () => {
  const blocker = createServer(), blockedPort = await listen(blocker), firstPort = await unusedPort();
  try {
    await expect(startGuest(parseGuestConfiguration({ schemaVersion: 1, endpoint: "127.0.0.1:12345", tunnels: [
      { name: "one", protocol: "tcp", localPort: firstPort, token }, { name: "two", protocol: "tcp", localPort: blockedPort, token }
    ] }))).rejects.toThrow(/EADDRINUSE/);
    const replacement = createServer();
    await new Promise<void>((resolve, reject) => { replacement.once("error", reject); replacement.listen(firstPort, "127.0.0.1", resolve); });
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  } finally { await new Promise<void>((resolve) => blocker.close(() => resolve())); }
});
