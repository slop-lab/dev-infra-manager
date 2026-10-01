import { once } from "node:events";
import { mkdtemp, readdir, rm, rmdir, symlink, unlink } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDimController, registerPlugins } from "@slop-lab/dim-core";
import { createExternalUrlsPlugin } from "../../plugin-external-urls/src/index.js";

const workspace = { id: "project:work", name: "work", projectId: "project", projectName: "project" };

describe("TCP external URL API semantics", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).reverse().map((operation) => operation()));
  });

  it.each([
    ["subdomain", { subdomain: "work--tcp" }],
    ["path", { path: "/ssh" }]
  ])("rejects an explicit %s for a TCP ingress", async (_field, extra) => {
    // Given: an authenticated workspace and a TCP ingress.
    const harness = await startHarness(cleanup);

    // When: the caller supplies an HTTP-only routing field.
    const response = await createUrl(harness.base, extra);

    // Then: validation rejects it before target resolution or listener ownership.
    expect(response.status).toBe(400);
  });

  it("replays an identical TCP request with one stored ID and one revoke", async () => {
    // Given: one successful TCP exposure request.
    const harness = await startHarness(cleanup);
    const first = await createUrl(harness.base);
    const firstBody = responseBody(await first.json());

    // When: the exact request is posted again and its returned route is deleted.
    const replay = await createUrl(harness.base);
    const replayBody = responseBody(await replay.json());
    const removed = await fetch(`${harness.base}/api/urls/${replayBody.urls[0]?.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer valid" }
    });

    // Then: replay reuses one durable identity and that one deletion revokes the listener.
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replayBody).toEqual(firstBody);
    expect(removed.status).toBe(204);
    await expect(exchange(harness.listenPort, "revoked")).rejects.toThrow();
  });

  it("does not revoke an existing claim when replay persistence fails", async () => {
    // Given: listener ownership remains after its persisted entry is externally lost.
    const harness = await startHarness(cleanup);
    const created = await createUrl(harness.base);
    expect(created.status).toBe(201);
    const directory = path.join(
      harness.stateRoot,
      "plugins",
      "external-urls",
      Buffer.from(workspace.id).toString("base64url")
    );
    const stored = (await readdir(directory)).find((name) => name.endsWith(".json"));
    if (stored === undefined) throw new Error("missing stored external URL");
    await unlink(path.join(directory, stored));
    await rmdir(directory);
    await symlink("/proc", directory);

    // When: the same logical claim is reprovisioned but durable storage rejects the write.
    const failed = await createUrl(harness.base);

    // Then: only a newly acquired provisional claim may be rolled back.
    expect(failed.status).toBe(500);
    expect(await exchange(harness.listenPort, "still-owned")).toBe("still-owned");
  });

  it("disconnects an active flow when nested target identity changes behind one relay", async () => {
    // Given: an active TCP route whose endpoint remains stable across target generations.
    let fingerprint = "leaf-generation-1";
    const harness = await startHarness(cleanup, () => fingerprint);
    expect((await createUrl(harness.base)).status).toBe(201);
    const client = await connect(harness.listenPort);
    const closed = once(client, "close");

    // When: reconciliation observes a replacement leaf behind the same host and port.
    fingerprint = "leaf-generation-2";
    const listed = await fetch(`${harness.base}/api/urls`, {
      headers: { authorization: "Bearer valid" }
    });

    // Then: the old generation's active flow is disconnected.
    expect(listed.status).toBe(200);
    await expect(within(closed, 500)).resolves.toBeDefined();
  });
});

async function startHarness(
  cleanup: Array<() => Promise<void>>,
  fingerprint: () => string = () => "leaf-generation-1"
): Promise<{ readonly base: string; readonly listenPort: number; readonly stateRoot: string }> {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-tcp-api-"));
  cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
  const target = net.createServer((socket) => socket.pipe(socket));
  await listen(target);
  cleanup.push(() => close(target));
  const targetPort = address(target).port;
  const listenPort = await availablePort();
  const registered = await registerPlugins([createExternalUrlsPlugin({
    ingresses: {
      tcp: {
        description: "TCP",
        scheme: "tcp",
        domain: "127.0.0.1",
        listenHost: "127.0.0.1",
        listenPort
      }
    }
  })]);
  cleanup.push(() => registered.dispose());
  const controller = createDimController({
    stateRoot,
    routes: registered.controllerRoutes,
    authenticate: async () => workspace,
    resolveTarget: async (_workspace, target) => ({
      protocol: target.protocol,
      host: "127.0.0.1",
      port: targetPort,
      fingerprint: fingerprint()
    })
  });
  await listen(controller);
  cleanup.push(() => close(controller));
  return { base: `http://127.0.0.1:${address(controller).port}`, listenPort, stateRoot };
}

function createUrl(base: string, extra: Readonly<Record<string, string>> = {}): Promise<Response> {
  return fetch(`${base}/api/urls`, {
    method: "POST",
    headers: { authorization: "Bearer valid", "content-type": "application/json" },
    body: JSON.stringify({
      ingress: "tcp",
      target: { containers: ["parent", "leaf"], port: 22, protocol: "tcp" },
      ...extra
    })
  });
}

function responseBody(value: unknown): { readonly urls: readonly [{ readonly id: string; readonly url: string }] } {
  if (!value || typeof value !== "object" || !("urls" in value) || !Array.isArray(value.urls)
    || value.urls.length !== 1) {
    throw new Error("expected one external URL");
  }
  const entry = value.urls[0];
  if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string"
    || !("url" in entry) || typeof entry.url !== "string") {
    throw new Error("expected external URL identity");
  }
  return { urls: [{ id: entry.id, url: entry.url }] };
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await listen(server);
  const port = address(server).port;
  await close(server);
  return port;
}

function listen(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: net.Server): Promise<void> {
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
  return new Promise((resolve, reject) => {
    let received = false;
    socket.once("data", (chunk) => {
      received = true;
      resolve(String(chunk));
    });
    socket.once("error", reject);
    socket.once("close", () => {
      if (!received) reject(new Error("connection closed without data"));
    });
    socket.write(message);
  });
}

function address(server: net.Server): net.AddressInfo {
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("missing address");
  return value;
}

function within<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`operation exceeded ${milliseconds}ms`)), milliseconds);
    })
  ]);
}
