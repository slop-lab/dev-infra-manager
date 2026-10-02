import { once } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControllerWorkspace, ResolvedWorkspaceTarget, WorkspaceTarget } from "@slop-lab/dim-core";
import { TcpIngressListener, type TcpExternalRoute } from "../../plugin-external-urls/src/tcpIngress.js";
import { within } from "./support/within.js";

const workspace: ControllerWorkspace = {
  id: "project:work",
  name: "work",
  projectId: "project",
  projectName: "project"
};
const target: WorkspaceTarget = { containers: ["service"], port: 22, protocol: "tcp" };
const serverSockets = new WeakMap<net.Server, Set<net.Socket>>();

describe("TCP ingress connection lifecycle", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).reverse().map((operation) => operation()));
  });

  it("disconnects an established flow when its route is revoked", async () => {
    // Given: an established connection through an owned route.
    const upstream = net.createServer();
    await listen(upstream);
    cleanup.push(() => close(upstream));
    const { listener, route, port } = await provision(upstream);
    cleanup.push(() => listener.close());
    const client = await connect(port);
    const closed = once(client, "close");

    // When: the owning route is revoked.
    await listener.revoke(route);

    // Then: its active client is disconnected promptly.
    await within(closed, 500);
    expect(client.destroyed).toBe(true);
  });

  it("closes promptly while a client and upstream remain active", async () => {
    // Given: an active connection with neither peer ending it.
    const upstream = net.createServer();
    await listen(upstream);
    cleanup.push(() => close(upstream));
    const { listener, port } = await provision(upstream);
    const client = await connect(port);
    const closed = once(client, "close");

    // When: the listener closes.
    await within(listener.close(), 500);

    // Then: both listener shutdown and client disconnection are bounded.
    await within(closed, 500);
    expect(client.destroyed).toBe(true);
  });

  it("rejects connections above its configured maximum", async () => {
    // Given: a listener whose one connection slot is occupied.
    let accepted = 0;
    const upstream = net.createServer(() => { accepted += 1; });
    await listen(upstream);
    cleanup.push(() => close(upstream));
    const { listener, port } = await provision(upstream, { maxConnections: 1 });
    cleanup.push(() => listener.close());
    const first = await connect(port);
    cleanup.push(async () => { first.destroy(); });
    await once(upstream, "connection");

    // When: another client connects while the capacity is exhausted.
    const second = await connect(port);

    // Then: the listener closes it without opening another upstream.
    await within(once(second, "close"), 500);
    expect(accepted).toBe(1);
  });

  it("disconnects a connection after its idle deadline", async () => {
    // Given: an established but inactive connection with a short test deadline.
    const upstream = net.createServer();
    await listen(upstream);
    cleanup.push(() => close(upstream));
    const { listener, port } = await provision(upstream, { idleTimeoutMs: 30 });
    cleanup.push(() => listener.close());
    const client = await connect(port);

    // When: neither peer transfers bytes before the idle deadline.
    const closed = once(client, "close");

    // Then: the flow is terminated within the configured bound.
    await within(closed, 500);
    expect(client.destroyed).toBe(true);
  });

  it("disconnects a client when the upstream connect deadline expires", async () => {
    // Given: an upstream connection attempt that never connects or errors.
    const upstream = net.createServer();
    await listen(upstream);
    cleanup.push(() => close(upstream));
    const connectSpy = vi.spyOn(net, "connect").mockImplementation(() => new net.Socket());
    cleanup.push(async () => { connectSpy.mockRestore(); });
    const { listener, port } = await provision(upstream, { connectTimeoutMs: 30 });
    cleanup.push(() => listener.close());
    const client = await connect(port);

    // When: the connect deadline expires without an upstream handshake.
    const closed = once(client, "close");

    // Then: the waiting client is disconnected within the configured bound.
    await within(closed, 500);
    expect(client.destroyed).toBe(true);
  });

  it("refreshes a recreated upstream for the same claim and rejects another claim", async () => {
    // Given: one owned route and an active flow to its original upstream.
    const firstTarget = net.createServer((socket) => socket.on("data", () => socket.end("first")));
    const secondTarget = net.createServer((socket) => socket.on("data", () => socket.end("second")));
    await Promise.all([listen(firstTarget), listen(secondTarget)]);
    cleanup.push(() => Promise.all([close(firstTarget), close(secondTarget)]).then(() => {}));
    const port = await availablePort();
    const listener = new TcpIngressListener(options(port));
    cleanup.push(() => listener.close());
    const request = { target };
    await listener.provision(workspace, request, resolved(firstTarget));
    const oldClient = await connect(port);
    const oldClosed = once(oldClient, "close");

    // When: reconciliation resolves the same logical claim to a recreated target.
    const route = (await listener.provision(workspace, request, resolved(secondTarget))).route;

    // Then: old flows are revoked, new flows use the replacement, and another claim is rejected.
    await within(oldClosed, 500);
    expect(await exchange(port, "probe")).toBe("second");
    await expect(listener.provision(
      { ...workspace, id: "project:other", name: "other" },
      request,
      resolved(firstTarget)
    )).rejects.toThrow(/already targets another service/);
    await listener.revoke(route);
  });
});

type ListenerLimits = {
  readonly maxConnections?: number;
  readonly connectTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
};

async function provision(server: net.Server, limits: ListenerLimits = {}): Promise<{
  readonly listener: TcpIngressListener;
  readonly route: TcpExternalRoute;
  readonly port: number;
}> {
  const port = await availablePort();
  const listener = new TcpIngressListener({ ...options(port), ...limits });
  const route = (await listener.provision(workspace, { target }, resolved(server))).route;
  return { listener, route, port };
}

function options(port: number) {
  return {
    name: "tcp",
    listenHost: "127.0.0.1",
    listenPort: port,
    publicHost: "127.0.0.1",
    upstreamMode: "container-ip" as const
  };
}

function resolved(server: net.Server): ResolvedWorkspaceTarget {
  const port = address(server).port;
  return { protocol: "tcp", host: "127.0.0.1", port, fingerprint: `tcp:${port}` };
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await listen(server);
  const port = address(server).port;
  await close(server);
  return port;
}

function listen(server: net.Server): Promise<void> {
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

function close(server: net.Server): Promise<void> {
  for (const socket of serverSockets.get(server) ?? []) socket.destroy();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function connect(port: number): Promise<net.Socket> {
  const socket = new net.Socket();
  socket.connect(port, "127.0.0.1");
  await once(socket, "connect");
  return socket;
}

async function exchange(port: number, message: string): Promise<string> {
  const socket = await connect(port);
  socket.write(message);
  const [chunk] = await once(socket, "data");
  socket.destroy();
  return String(chunk);
}

function address(server: net.Server): net.AddressInfo {
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("missing TCP address");
  return value;
}
