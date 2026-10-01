import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDevelopmentServiceGateway } from "../../../../core/packages/controller-proxy/src/development-service-gateway.js";

describe("development service gateway", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(cleanup.splice(0).reverse().map((item) => item())));

  it("routes HTTP by exact forwarded authority and supports target port changes", async () => {
    const stateDirectory = await temporaryState(cleanup);
    const first = await applicationServer("first", cleanup);
    const second = await applicationServer("second", cleanup);
    const gateway = createDevelopmentServiceGateway({ listenPort: 0, stateDirectory });
    const gatewayPort = await gateway.listen();
    cleanup.push(() => gateway.close());
    await gateway.setRoute(route(first.port));

    const firstResponse = await httpRequest(gatewayPort, {
      host: `127.0.0.1:${gatewayPort}`,
      "x-forwarded-host": "demo.example.test"
    });
    expect(firstResponse).toEqual({ status: 200, body: "first:demo.example.test" });

    await gateway.setRoute(route(second.port));
    const secondResponse = await httpRequest(gatewayPort, { host: "demo.example.test" });
    expect(secondResponse).toEqual({ status: 200, body: "second:demo.example.test" });
  });

  it("accepts peer-interface traffic while keeping application upstreams on loopback", async () => {
    const stateDirectory = await temporaryState(cleanup);
    const application = await applicationServer("peer", cleanup);
    const gateway = createDevelopmentServiceGateway({ listenPort: 0, stateDirectory });
    const gatewayPort = await gateway.listen();
    cleanup.push(() => gateway.close());
    await gateway.setRoute(route(application.port));

    const peerAddress = nonLoopbackIpv4();
    const response = await httpRequest(gatewayPort, {
      host: `127.0.0.1:${gatewayPort}`,
      "x-forwarded-host": "demo.example.test"
    }, peerAddress);
    const unknown = await httpRequest(gatewayPort, { host: "unknown.example.test" }, peerAddress);

    expect(response).toEqual({ status: 200, body: "peer:demo.example.test" });
    expect(unknown.status).toBe(404);
  });

  it("rejects unknown and ambiguous authorities without contacting an application", async () => {
    const stateDirectory = await temporaryState(cleanup);
    const application = await applicationServer("known", cleanup);
    const gateway = createDevelopmentServiceGateway({ listenPort: 0, stateDirectory });
    const gatewayPort = await gateway.listen();
    cleanup.push(() => gateway.close());
    await gateway.setRoute(route(application.port));

    expect(await httpRequest(gatewayPort, { host: "unknown.example.test" })).toMatchObject({ status: 404 });
    expect(await httpRequest(gatewayPort, {
      host: "demo.example.test",
      "x-forwarded-host": "other.example.test"
    })).toMatchObject({ status: 400 });
  });

  it("returns 400 for malformed authorities and remains healthy", async () => {
    const stateDirectory = await temporaryState(cleanup);
    const application = await applicationServer("healthy", cleanup);
    const gateway = createDevelopmentServiceGateway({ listenPort: 0, stateDirectory });
    const gatewayPort = await gateway.listen();
    cleanup.push(() => gateway.close());
    await gateway.setRoute(route(application.port));

    const malformed = await rawStatus(gatewayPort, "GET / HTTP/1.1\r\nHost: [\r\n\r\n");
    const healthy = await httpRequest(gatewayPort, { host: "demo.example.test" });

    expect(malformed).toBe(400);
    expect(healthy).toEqual({ status: 200, body: "healthy:demo.example.test" });
  });

  it("forwards WebSocket upgrades selected by the original Host authority", async () => {
    const stateDirectory = await temporaryState(cleanup);
    const application = http.createServer();
    application.on("upgrade", (request, socket) => {
      socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello");
    });
    const address = await listen(application);
    cleanup.push(() => closeServer(application));
    const gateway = createDevelopmentServiceGateway({ listenPort: 0, stateDirectory });
    const gatewayPort = await gateway.listen();
    cleanup.push(() => gateway.close());
    await gateway.setRoute(route(address.port));

    const response = await rawRequest(gatewayPort,
      "GET /socket HTTP/1.1\r\nHost: demo.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    expect(response).toContain("101 Switching Protocols");
    expect(response).toContain("hello");
  });
});

function route(targetPort: number) {
  return {
    name: "demo",
    urlId: "url-1",
    url: "https://demo.example.test",
    authority: "demo.example.test",
    ingress: "https-main",
    targetPort
  };
}

async function temporaryState(cleanup: Array<() => Promise<void>>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "dim-development-service-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function applicationServer(label: string, cleanup: Array<() => Promise<void>>) {
  const server = http.createServer((request, response) => response.end(`${label}:${request.headers.host}`));
  const address = await listen(server);
  cleanup.push(() => closeServer(server));
  return address;
}

function listen(server: http.Server): Promise<net.AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address === "object" && address !== null) resolve(address);
      else reject(new Error("server did not bind a TCP address"));
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function httpRequest(
  port: number,
  headers: http.OutgoingHttpHeaders,
  host = "127.0.0.1"
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host, port, path: "/", headers }, async (response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      resolve({ status: response.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") });
    });
    request.once("error", reject);
    request.end();
  });
}

function nonLoopbackIpv4(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    const address = addresses?.find((candidate) => candidate.family === "IPv4" && !candidate.internal);
    if (address !== undefined) return address.address;
  }
  throw new Error("test requires a non-loopback IPv4 interface");
}

function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      if (Buffer.concat(chunks).includes("hello")) {
        socket.destroy();
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", reject);
  });
}

function rawStatus(port: number, request: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.end(request));
    socket.setTimeout(500, () => socket.destroy(new Error("gateway response timed out")));
    socket.once("data", (chunk) => {
      const match = chunk.toString("utf8").match(/^HTTP\/1\.1 (\d{3})/);
      socket.destroy();
      if (match?.[1] === undefined) reject(new Error("gateway returned an invalid HTTP response"));
      else resolve(Number(match[1]));
    });
    socket.once("error", reject);
  });
}
