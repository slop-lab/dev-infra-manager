import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDimController, registerPlugins } from "@slop-lab/dim-core";
import { createExternalUrlsPlugin } from "../../plugin-external-urls/src/index.js";
import { within } from "./support/within.js";

const cleanup: Array<() => Promise<void>> = [];
const serverSockets = new WeakMap<http.Server, Set<net.Socket>>();

afterEach(async () => Promise.all(cleanup.splice(0).reverse().map((operation) => operation())).then(() => {}));

it("closes live HTTP streams and WebSocket flows when their route is revoked", async () => {
  // Given: live streaming and upgraded flows through one real route.
  const harness = await startHarness();
  const stream = await openStream(harness.ingressPort);
  const websocket = await openWebSocket(harness.mirrorPort);
  expect(stream.firstChunk).toBe("first-stream");
  expect(await websocketExchange(websocket, "before-revoke")).toContain("first:before-revoke");
  const streamClosed = httpFlowClosed(stream.response);
  const websocketClosed = once(websocket, "close");

  // When: the owning route is deleted.
  expect((await harness.deleteRoute()).status).toBe(204);

  // Then: both established flows close and subsequent HTTP traffic is denied.
  await within(Promise.all([streamClosed, websocketClosed]), 1_000);
  expect(stream.response.destroyed).toBe(true);
  expect(websocket.destroyed).toBe(true);
  expect(await proxyRequest(harness.ingressPort)).toEqual({ status: 404, body: '{"error":"external route not found"}\n' });
});

it("closes live HTTP streams and WebSocket flows before rebinding a route upstream", async () => {
  // Given: live streaming and upgraded flows to the first target generation.
  const harness = await startHarness();
  const stream = await openStream(harness.ingressPort);
  const websocket = await openWebSocket(harness.mirrorPort);
  expect(stream.firstChunk).toBe("first-stream");
  expect(await websocketExchange(websocket, "before-refresh")).toContain("first:before-refresh");
  const streamClosed = httpFlowClosed(stream.response);
  const websocketClosed = once(websocket, "close");

  // When: reconciliation resolves the same route claim to a replacement target.
  const reconciled = await harness.rebind();

  // Then: stale flows close before new HTTP and WebSocket traffic reaches only the replacement.
  expect(reconciled.status).toBe(200);
  await within(Promise.all([streamClosed, websocketClosed]), 1_000);
  expect(await proxyRequest(harness.ingressPort)).toEqual({ status: 200, body: "second" });
  const replacementWebSocket = await openWebSocket(harness.mirrorPort);
  cleanup.push(async () => { replacementWebSocket.destroy(); });
  expect(await websocketExchange(replacementWebSocket, "after-refresh")).toContain("second:after-refresh");
});

async function startHarness(): Promise<{
  readonly ingressPort: number;
  readonly mirrorPort: number;
  readonly deleteRoute: () => Promise<Response>;
  readonly rebind: () => Promise<Response>;
}> {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-http-flow-"));
  cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
  const first = createUpstream("first");
  const second = createUpstream("second");
  await Promise.all([listen(first), listen(second)]);
  cleanup.push(() => Promise.all([close(first), close(second)]).then(() => {}));
  let targetPort = port(first);
  const ingressPort = await availablePort();
  const mirrorPort = await availablePort();
  const registered = await registerPlugins([createExternalUrlsPlugin({ ingresses: {
    public: {
      description: "HTTP flow lifecycle",
      scheme: "http",
      domain: "example.test",
      listenHost: "127.0.0.1",
      listenPort: ingressPort
    },
    mirror: {
      description: "HTTP flow mirror",
      scheme: "http",
      domain: "example.test",
      listenHost: "127.0.0.1",
      listenPort: mirrorPort
    }
  } })]);
  cleanup.push(() => registered.dispose());
  const workspace = { id: "workspace-id", name: "work", projectId: "project-id", projectName: "project" };
  const controller = createDimController({
    stateRoot,
    routes: registered.controllerRoutes,
    authenticate: async () => workspace,
    runWorkspaceRequest: async (_workspace, operation) => operation(),
    resolveTarget: async () => ({
      protocol: "http",
      host: "127.0.0.1",
      port: targetPort,
      fingerprint: `target:${targetPort}`
    })
  });
  await listen(controller);
  cleanup.push(() => close(controller));
  const base = `http://127.0.0.1:${port(controller)}/api/urls`;
  const headers = { authorization: "Bearer grant", "content-type": "application/json" };
  const created = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ingress: "public",
      subdomain: "work--app",
      target: { containers: ["agent"], port: 8080, protocol: "http" }
    })
  });
  const id = routeId(await created.json());
  return {
    ingressPort,
    mirrorPort,
    deleteRoute: () => fetch(`${base}/${id}`, { method: "DELETE", headers }),
    rebind: () => {
      targetPort = port(second);
      return fetch(base, { headers });
    }
  };
}

function createUpstream(label: string): http.Server {
  const server = http.createServer((request, response) => {
    if (request.url === "/stream") {
      response.writeHead(200);
      response.write(`${label}-stream`);
      return;
    }
    response.end(label);
  });
  server.on("upgrade", (_request, socket) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Upstream: ${label}\r\n\r\n`);
    socket.on("data", (chunk) => socket.write(`${label}:${String(chunk)}`));
  });
  return server;
}

async function openStream(ingressPort: number): Promise<{
  readonly response: http.IncomingMessage;
  readonly firstChunk: string;
}> {
  const request = http.request({
    hostname: "127.0.0.1",
    port: ingressPort,
    path: "/stream",
    headers: { host: "work--app.example.test" }
  });
  request.end();
  const [response] = await once(request, "response");
  if (!(response instanceof http.IncomingMessage)) throw new Error("missing streaming response");
  const [chunk] = await once(response, "data");
  return { response, firstChunk: String(chunk) };
}

async function openWebSocket(ingressPort: number): Promise<net.Socket> {
  const socket = net.connect(ingressPort, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    "GET /socket HTTP/1.1\r\n"
    + "Host: work--app.example.test\r\n"
    + "Connection: Upgrade\r\n"
    + "Upgrade: websocket\r\n\r\n"
  );
  const handshake = await readUntil(socket, "\r\n\r\n");
  expect(handshake).toContain("101 Switching Protocols");
  return socket;
}

async function websocketExchange(socket: net.Socket, message: string): Promise<string> {
  socket.write(message);
  return readUntil(socket, message);
}

function readUntil(socket: net.Socket, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    const onData = (chunk: Buffer) => {
      received += String(chunk);
      if (!received.includes(marker)) return;
      socket.off("error", onError);
      socket.off("data", onData);
      resolve(received);
    };
    const onError = (error: Error) => {
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function proxyRequest(ingressPort: number): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: ingressPort,
      headers: { host: "work--app.example.test" }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 500,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

function httpFlowClosed(response: http.IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    response.once("close", resolve);
    response.once("aborted", resolve);
    response.once("error", (error) => {
      if (error.message === "aborted") resolve();
      else reject(error);
    });
  });
}

function routeId(value: unknown): string {
  if (!value || typeof value !== "object" || !("urls" in value) || !Array.isArray(value.urls)) {
    throw new Error("expected external URL response");
  }
  const route = value.urls[0];
  if (!route || typeof route !== "object" || !("id" in route) || typeof route.id !== "string") {
    throw new Error("expected external URL route ID");
  }
  return route.id;
}

async function availablePort(): Promise<number> {
  const server = http.createServer();
  await listen(server);
  const selected = port(server);
  await close(server);
  return selected;
}

function listen(server: http.Server): Promise<void> {
  const sockets = new Set<net.Socket>();
  serverSockets.set(server, sockets);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  for (const socket of serverSockets.get(server) ?? []) socket.destroy();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function port(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return address.port;
}
