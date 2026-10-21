import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startExternalUrlIngress } from "../../../../packages/control-plane/plugins/external-urls/src/index.js";
import { controlPlaneIngressDriver } from "../../../../packages/host/plugins/external-urls/src/controlPlaneIngress.js";
import { WorkspaceIngressListener } from "../../../../packages/host/plugins/external-urls/src/httpIngress.js";
import { WorkspaceRouteRegistry } from "../../../../packages/host/plugins/external-urls/src/httpRouteRegistry.js";
import type { IngressDriverContext } from "../../../../packages/host/plugins/external-urls/src/plugin-api.js";
import type { ExternalRoute } from "../../../../packages/host/plugins/external-urls/src/routeStore.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });

it("routes two IP-only host relays through one public wildcard, scopes identical names and revokes streams", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dim-shared-ingress-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const first = await backend("first"), second = await backend("second");
  const relayPorts = [await freePort(), await freePort()];
  const tokens = ["a".repeat(40), "b".repeat(40)];
  const config = { schemaVersion: 1 as const, domain: "dev.example.test", publicListen: { host: "127.0.0.1", port: 0 }, managementListen: { host: "127.0.0.1", port: 0 }, hosts: relayPorts.map((port, index) => ({ id: `host-${index}`, token: tokens[index]!, relayOrigin: `http://127.0.0.1:${port}` })) };
  let service = await startExternalUrlIngress(config, new AbortController().signal);
  cleanup.push(() => service.close());
  const listeners: WorkspaceIngressListener[] = [];
  const claims: ExternalRoute[] = [];
  for (const [index, target] of [first, second].entries()) {
    const file = join(directory, `host-${index}.json`);
    await writeFile(file, JSON.stringify({ schemaVersion: 1, endpoint: service.managementOrigin, hostId: `host-${index}`, token: tokens[index], domain: "dev.example.test" }), { mode: 0o600 });
    const runtime = await controlPlaneIngressDriver.runtime(JSON.stringify({ connectionFile: file, listenHost: "127.0.0.1", listenPort: relayPorts[index] }), {} as IngressDriverContext, "https");
    cleanup.push(async () => runtime.close?.());
    const listener = new WorkspaceIngressListener(new WorkspaceRouteRegistry(), { ...runtime, scheme: "https", name: "shared" }, { info() {}, error() {}, debug() {}, warn() {} });
    cleanup.push(() => listener.close()); listeners.push(listener);
    const claim = await listener.provision({ id: `workspace-${index}`, name: "same-name" }, { ingress: "shared", subdomain: "same-name--opencode", target: { containers: [], port: target.port, protocol: "http" } }, { host: "127.0.0.1", port: target.port, protocol: "http", fingerprint: `owned-${index}` }, randomUUID(), "approved", randomUUID());
    claims.push(claim.route);
  }
  for (const claim of claims) {
    expect(new URL(claim.url!).hostname).toMatch(/^[^.]+\.dev\.example\.test$/);
    expect(claim.url).not.toContain("127.0.0.1");
  }
  expect(claims[0]!.authority).toBe("same-name--opencode.dev.example.test");
  expect(claims[1]!.authority).toMatch(/^same-name--opencode-[a-f0-9]{16}\.dev\.example\.test$/);
  expect(claims[0]!.authority).not.toBe(claims[1]!.authority);
  expect(await get(service.publicOrigin, claims[0]!.authority)).toEqual({ status: 200, body: "first" });
  expect(await get(service.publicOrigin, claims[1]!.authority)).toEqual({ status: 200, body: "second" });
  expect(await get(service.publicOrigin, claims[0]!.permalinkAuthority!)).toEqual({ status: 200, body: "first" });
  const stream = await new Promise<http.IncomingMessage>((resolve, reject) => { const request = http.get(`${service.publicOrigin}/events`, { headers: { host: claims[0]!.authority } }, resolve); request.once("error", reject); });
  stream.on("error", () => {}); await once(stream, "data");
  const socket = new WebSocket(`${service.publicOrigin.replace("http", "ws")}/socket`, { headers: { host: claims[0]!.authority } }); socket.on("error", () => {});
  await once(socket, "open"); socket.send("hello"); expect((await once(socket, "message"))[0].toString()).toBe("first:hello");
  const streamClosed = new Promise<void>((resolve) => stream.once("close", resolve)), socketClosed = once(socket, "close");
  await listeners[0]!.revoke(claims[0]!);
  await Promise.all([streamClosed, socketClosed]);
  expect((await get(service.publicOrigin, claims[0]!.authority)).status).toBe(404);
  expect(await get(service.publicOrigin, claims[1]!.authority)).toEqual({ status: 200, body: "second" });
  const repeated = await listeners[1]!.provision({ id: "workspace-1", name: "same-name" },
    { ingress: "shared", subdomain: "same-name--opencode", target: { containers: [], port: second.port, protocol: "http" } },
    { host: "127.0.0.1", port: second.port, protocol: "http", fingerprint: "owned-1" }, claims[1]!.ingressId!, "approved",
    /-permalink-([a-f0-9-]{36})\./.exec(claims[1]!.permalinkAuthority!)![1]!, undefined, claims[1]!.authority);
  expect(repeated.route.authority).toBe(claims[1]!.authority);
  expect((await get(service.publicOrigin, claims[0]!.authority)).status).toBe(404);
  const managementPort = Number(new URL(service.managementOrigin).port);
  await service.close();
  service = await startExternalUrlIngress({ ...config, managementListen: { host: "127.0.0.1", port: managementPort } }, new AbortController().signal);
  expect((await get(service.publicOrigin, claims[1]!.authority)).status).toBe(404);
  await expect.poll(async () => get(service.publicOrigin, claims[1]!.authority), { timeout: 12_000, interval: 100 }).toEqual({ status: 200, body: "second" });
});

it("authenticates host claims, rejects takeover and arbitrary upstreams, and fails closed on restart", async () => {
  const first = await backend("first"), second = await backend("second");
  const config = { schemaVersion: 1 as const, domain: "dev.example.test", publicListen: { host: "127.0.0.1", port: 0 }, managementListen: { host: "127.0.0.1", port: 0 }, hosts: [{ id: "first", token: "a".repeat(40), relayOrigin: first.origin }, { id: "second", token: "b".repeat(40), relayOrigin: second.origin }] };
  const service = await startExternalUrlIngress(config, new AbortController().signal); cleanup.push(() => service.close());
  const mutate = (host: string, token: string, body: unknown, method = "PUT") => fetch(`${service.managementOrigin}/v1/routes`, { method, headers: { "content-type": "application/json", "x-dim-host-id": host, authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const claim = { routeId: "workspace-1", authorities: ["app.dev.example.test"] };
  expect((await mutate("first", "wrong", claim)).status).toBe(401);
  expect((await mutate("first", config.hosts[0]!.token, claim)).status).toBe(200);
  expect((await mutate("second", config.hosts[1]!.token, claim)).status).toBe(409);
  expect((await mutate("second", config.hosts[1]!.token, claim, "DELETE")).status).toBe(409);
  expect((await mutate("first", config.hosts[0]!.token, { ...claim, relayOrigin: second.origin })).status).toBe(400);
  expect((await mutate("first", config.hosts[0]!.token, { ...claim, authorities: ["deep.app.dev.example.test"] })).status).toBe(400);
  expect((await mutate("first", config.hosts[0]!.token, { ...claim, routeId: "replacement-workspace" })).status).toBe(409);
  expect(await get(service.publicOrigin, claim.authorities[0]!)).toEqual({ status: 200, body: "first" });
  await service.close();
  const restarted = await startExternalUrlIngress(config, new AbortController().signal); cleanup.push(() => restarted.close());
  expect((await get(restarted.publicOrigin, claim.authorities[0]!)).status).toBe(404);
});

it("expires disconnected host leases and closes existing streams instead of retaining a stale forwarding path", async () => {
  const target = await backend("leased");
  const service = await startExternalUrlIngress({ schemaVersion: 1, domain: "dev.example.test", publicListen: { host: "127.0.0.1", port: 0 }, managementListen: { host: "127.0.0.1", port: 0 }, hosts: [{ id: "leased", token: "a".repeat(40), relayOrigin: target.origin }] }, new AbortController().signal);
  cleanup.push(() => service.close());
  const granted = await fetch(`${service.managementOrigin}/v1/routes`, { method: "PUT", headers: { "content-type": "application/json", "x-dim-host-id": "leased", authorization: `Bearer ${"a".repeat(40)}` }, body: JSON.stringify({ routeId: "owned", authorities: ["app.dev.example.test"] }) });
  expect(granted.status).toBe(200);
  const stream = await new Promise<http.IncomingMessage>((resolve, reject) => { const request = http.get(`${service.publicOrigin}/events`, { headers: { host: "app.dev.example.test" } }, resolve); request.once("error", reject); });
  stream.on("error", () => {}); await once(stream, "data");
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now + 36_000);
  try { await closed; expect((await get(service.publicOrigin, "app.dev.example.test")).status).toBe(404); }
  finally { clock.mockRestore(); }
});

it("prepares the host relay without a reachable control plane while rejecting publication until it reconnects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dim-shared-ingress-offline-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "connection.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 1, endpoint: `http://127.0.0.1:${await freePort()}`, hostId: "offline", token: "a".repeat(40), domain: "dev.example.test" }), { mode: 0o600 });
  const runtime = await controlPlaneIngressDriver.runtime(JSON.stringify({ connectionFile: file, listenHost: "127.0.0.1", listenPort: await freePort() }), {} as IngressDriverContext, "https");
  cleanup.push(async () => runtime.close?.());
  expect(runtime.domain).toBe("dev.example.test");
  await expect(runtime.publishRoute!({ id: randomUUID(), ingress: "shared", ingressId: "owned-workspace", authority: "app.dev.example.test", url: "https://app.dev.example.test/" })).rejects.toThrow("unreachable");
});

async function backend(label: string) {
  const server = http.createServer((request, response) => {
    if (request.url === "/events") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(`data: ${label}\n\n`); }
    else response.end(label);
  });
  const sockets = new Set<net.Socket>(); server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const websocket = new WebSocketServer({ server }); websocket.on("connection", (socket) => socket.on("message", (message) => socket.send(`${label}:${message}`)));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const value = server.address(); if (!value || typeof value === "string") throw new Error("listener missing");
  cleanup.push(async () => { for (const socket of websocket.clients) socket.terminate(); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { port: value.port, origin: `http://127.0.0.1:${value.port}` };
}
async function get(origin: string, authority: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => { const request = http.get(origin, { headers: { host: authority } }, (response) => { const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(Buffer.from(chunk))); response.once("error", reject); response.once("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") })); }); request.once("error", reject); });
}
async function freePort() { const server = net.createServer(); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); const value = server.address(); await new Promise<void>((resolve) => server.close(() => resolve())); if (!value || typeof value === "string") throw new Error("no port"); return value.port; }
