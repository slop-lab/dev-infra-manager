import { randomUUID } from "node:crypto";
import { createServer, request, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import { workspaceRecord } from "../../../support/workspaceFixture.js";
import { createGuestDockerProxy, type GuestProxyConfig } from "../../../../packages/host/plugins/mirrors/src/guest-proxy.js";
import { createMirrorRelay } from "../../../../packages/host/plugins/mirrors/src/relay.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function root() { const value = await mkdtemp(join(tmpdir(), "dim-auto-mirrors-")); cleanup.push(() => rm(value, { recursive: true, force: true })); return value; }
async function listen(server: Server, socket?: string) {
  await new Promise<void>((resolve) => socket ? server.listen(socket, resolve) : server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (typeof address === "string") return address;
  if (!address) throw new Error("listener absent"); return `http://127.0.0.1:${address.port}`;
}
async function unix(socket: string, path: string, body?: Buffer) {
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const outgoing = request({ socketPath: socket, path, method: body === undefined ? "GET" : "POST" }, (response) => {
      const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode ?? 500, body: Buffer.concat(chunks) }));
    }); outgoing.on("error", reject); outgoing.end(body);
  });
}
it("injects nested Docker/APT mirror defaults while preserving binary build streams and explicit user mount choices", async () => {
  const directory = await root(), engine = join(directory, "engine.sock"), socket = join(directory, "docker.sock");
  const received: Array<{ path: string; bytes: Buffer }> = [];
  const upstream = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); received.push({ path: request.url ?? "", bytes: Buffer.concat(chunks) }); response.end(Buffer.concat(chunks)); });
  await listen(upstream, engine);
  const config: GuestProxyConfig = { socket, engineSocket: engine, files: [{ source: "/workspace/mirrors/apt.conf", target: "/etc/apt/apt.conf.d/99dim-mirrors" }, { source: "/workspace/mirrors/daemon.json", target: "/etc/docker/daemon.json" }], environmentDefaults: [], blockedHostnames: ["registry-1.docker.io", "auth.docker.io"] };
  const proxy = createGuestDockerProxy(config); await new Promise<void>((resolve) => proxy.server.listen(socket, resolve)); cleanup.push(() => proxy.close());
  const response = await unix(socket, "/v1.53/containers/create?name=debian", Buffer.from(JSON.stringify({ Image: "debian:bookworm", HostConfig: { Binds: ["project-data:/workspace:rw"], ExtraHosts: ["internal.local:10.0.0.2"] }, Env: ["APP_URL=http://internal.local:3000"] })));
  expect(response.status).toBe(200);
  const value: unknown = JSON.parse(response.body.toString());
  expect(value).toMatchObject({ Env: ["APP_URL=http://internal.local:3000"], HostConfig: { Binds: ["project-data:/workspace:rw", "/workspace/mirrors/apt.conf:/etc/apt/apt.conf.d/99dim-mirrors:ro", "/workspace/mirrors/daemon.json:/etc/docker/daemon.json:ro"], ExtraHosts: ["internal.local:10.0.0.2", "registry-1.docker.io:127.0.0.1", "auth.docker.io:127.0.0.1"] } });
  expect(JSON.stringify(value)).not.toContain("HTTP_PROXY");
  const bytes = Buffer.from([0, 255, 1, 0, 128]); expect((await unix(socket, "/v1.53/build?t=local", bytes)).body).toEqual(bytes);
  const explicit = await unix(socket, "/containers/create", Buffer.from(JSON.stringify({ HostConfig: { Mounts: [{ Target: "/etc/docker/daemon.json", Source: "explicit", Type: "volume" }] } })));
  expect(JSON.stringify(JSON.parse(explicit.body.toString()))).not.toContain("/workspace/mirrors/daemon.json:");
  expect(received[1]?.bytes).toEqual(bytes);
});
it("passes Docker upgrade streams in both directions including final bytes after client half-close", async () => {
  const directory = await root(), engine = join(directory, "engine.sock"), socket = join(directory, "docker.sock");
  const upstream = createServer(); upstream.on("upgrade", (_request, stream, head) => {
    stream.allowHalfOpen = true; stream.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
    const chunks = [head]; stream.on("data", (chunk: Buffer) => chunks.push(chunk)); stream.on("end", () => stream.end(Buffer.concat(chunks)));
  }); await listen(upstream, engine);
  const proxy = createGuestDockerProxy({ socket, engineSocket: engine, files: [], environmentDefaults: [], blockedHostnames: [] });
  await new Promise<void>((resolve) => proxy.server.listen(socket, resolve)); cleanup.push(() => proxy.close());
  const bytes = Buffer.from([0, 255, 0, 1]);
  const response = await new Promise<Buffer>((resolve, reject) => {
    const client = connect({ path: socket, allowHalfOpen: true }), chunks: Buffer[] = [];
    client.on("error", reject); client.on("data", (chunk: Buffer) => chunks.push(chunk)); client.on("end", () => { client.destroy(); resolve(Buffer.concat(chunks)); });
    client.on("connect", () => client.end(Buffer.concat([Buffer.from("POST /v1.53/exec/id/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"), bytes])));
  }); expect(response.subarray(response.indexOf("\r\n\r\n") + 4)).toEqual(bytes);
});
async function relayFixture(upstream: (request: IncomingMessage, response: ServerResponse) => void) {
  const directory = await root(), store = new WorkspaceStore(join(directory, "workspaces")), workspace = workspaceRecord(); await store.write(workspace);
  const server = createServer(upstream), origin = await listen(server);
  const endpoints = { docker: origin + "/", apt: origin + "/", npm: origin + "/", pypi: origin + "/root/pypi/+simple/" };
  const relay = await createMirrorRelay({ workspaceStateRoot: store.root, workspaceId: workspace.id, workspaceName: workspace.name, listen: "127.0.0.1", endpoints, controlToken: "a".repeat(43), configurationId: randomUUID() });
  cleanup.push(() => relay.close()); return { relay, store, workspace, registry: `http://127.0.0.1:${relay.ports.docker}`, apt: `http://127.0.0.1:${relay.ports.apt}`, npm: `http://127.0.0.1:${relay.ports.npm}`, pypi: `http://127.0.0.1:${relay.ports.pypi}` };
}
it("limits cache access to fixed public reads, strips credentials and rejects APT SSRF/CONNECT", async () => {
  const received: Array<{ url: string; headers: IncomingMessage["headers"] }> = [];
  const f = await relayFixture((request, response) => { received.push({ url: request.url ?? "", headers: request.headers }); response.setHeader("set-cookie", "host-secret"); response.end("cache bytes"); });
  const response = await fetch(f.registry + "/v2/library/debian/manifests/bookworm", { headers: { authorization: "Bearer agent-secret", cookie: "host-secret", "x-forwarded-for": "metadata", accept: "application/vnd.oci.image.manifest.v1+json" } });
  expect(await response.text()).toBe("cache bytes"); expect(response.headers.get("set-cookie")).toBeNull();
  expect(received[0]?.headers).not.toHaveProperty("authorization"); expect(received[0]?.headers).not.toHaveProperty("cookie"); expect(received[0]?.headers).not.toHaveProperty("x-forwarded-for");
  expect((await fetch(f.registry + "/v2/library/debian/manifests/bookworm", { method: "DELETE" })).status).toBe(405);
  expect((await fetch(f.registry + "/admin")).status).toBe(403);
  const absolute = (path: string) => new Promise<number>((resolve, reject) => { const outgoing = request({ hostname: "127.0.0.1", port: f.relay.ports.apt, path }, (response) => { response.resume(); resolve(response.statusCode!); }); outgoing.on("error", reject); outgoing.end(); });
  expect(await absolute("http://deb.debian.org/debian/dists/bookworm/Release")).toBe(200);
  expect(received[1]?.url).toBe("http://deb.debian.org/debian/dists/bookworm/Release");
  for (const target of ["http://169.254.169.254/", "http://127.0.0.1/private", "http://deb.debian.org:8787/private", "http://user:secret@deb.debian.org/file", "https://deb.debian.org/file"]) expect(await absolute(target)).toBe(403);
});
it("closes in-flight public cache flows when a discarded display name is reused", async () => {
  const f = await relayFixture((_request, response) => { response.writeHead(200); response.write("prefix"); });
  const response = await fetch(f.registry + "/v2/stream");
  const body = response.text();
  await f.store.write({ ...f.workspace, id: randomUUID() });
  await f.relay.closed;
  await expect(body).rejects.toThrow();
  await expect(fetch(f.registry + "/v2/stream")).rejects.toThrow();
});

it("flushes Docker wait response headers before body bytes so container startup cannot deadlock", async () => {
  const directory = await root(), engine = join(directory, "engine.sock"), socket = join(directory, "docker.sock");
  let complete: (() => void) | undefined;
  const upstream = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.flushHeaders(); complete = () => response.end('{"StatusCode":0}'); });
  await listen(upstream, engine);
  const proxy = createGuestDockerProxy({ socket, engineSocket: engine, files: [], environmentDefaults: [], blockedHostnames: [] });
  await new Promise<void>((resolve) => proxy.server.listen(socket, resolve)); cleanup.push(() => proxy.close());
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request({ socketPath: socket, path: "/v1.53/containers/id/wait?condition=next-exit", method: "POST", signal: AbortSignal.timeout(2_000) }, resolve);
    outgoing.on("error", reject); outgoing.end();
  });
  expect(response.statusCode).toBe(200); expect(complete).toBeTypeOf("function");
  complete!();
  const chunks: Buffer[] = []; for await (const chunk of response) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ StatusCode: 0 });
});

it("reuses a detached UUID relay across pause/resume and atomically refreshes cache targets without changing guest ports", async () => {
  const { ensureWorkspaceRelay }: typeof import("../../../../packages/host/plugins/mirrors/src/attachment.js") = await import(new URL("../../../../packages/host/plugins/mirrors/dist/attachment.js", import.meta.url).href);
  const { tryAcquireKernelGuard } = await import("@slop-lab/dim-host-core");
  const directory = await root(), store = new WorkspaceStore(join(directory, "workspaces")), workspace = workspaceRecord(); await store.write(workspace);
  const a = new URL(await listen(createServer((_request, response) => response.end("first cache"))));
  const b = new URL(await listen(createServer((_request, response) => response.end("replacement cache"))));
  const relayRoot = join(directory, "relay"), input = { workspaceStateRoot: store.root, workspaceName: workspace.name, workspaceId: workspace.id, listen: "127.0.0.1",
    endpoints: { docker: a.href, apt: a.href, npm: a.href, pypi: a.href } };
  cleanup.push(async () => {
    await store.remove(workspace.name).catch(() => {});
    for (let index = 0; index < 100; index++) {
      const guard = await tryAcquireKernelGuard(join(relayRoot, "relay.guard"));
      if (guard) { await guard.release(); return; }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("detached relay did not release its lifecycle guard");
  });
  const signal = AbortSignal.timeout(10_000);
  const [first, replay] = await Promise.all([ensureWorkspaceRelay(relayRoot, input, signal), ensureWorkspaceRelay(relayRoot, input, signal)]);
  expect(replay).toEqual(first);
  const endpoint = `http://127.0.0.1:${first.ports.docker}/v2/cache`;
  expect(await (await fetch(endpoint)).text()).toBe("first cache");
  const next = { ...input, endpoints: { ...input.endpoints, docker: b.href } };
  expect(await ensureWorkspaceRelay(relayRoot, next, signal)).toEqual(first);
  expect(await (await fetch(endpoint)).text()).toBe("replacement cache");
  await store.write({ ...workspace, phase: "stopped" }); expect((await fetch(endpoint)).status).toBe(503);
  await store.write(workspace); expect(await ensureWorkspaceRelay(relayRoot, next, signal)).toEqual(first);
  expect(await (await fetch(endpoint)).text()).toBe("replacement cache");
});

it("serves npm and PyPI metadata plus artifact bytes through the workspace relay without origin bypass", async () => {
  const bytes = Buffer.from([0, 255, 128, 42]);
  const received: string[] = [];
  const f = await relayFixture((request, response) => {
    const path = request.url ?? ""; received.push(path);
    if (path === "/package") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ dist: { tarball: `http://${request.headers.host}/package/-/package.tgz` } }));
    } else if (path === "/root/pypi/+simple/example/") {
      response.setHeader("content-type", "text/html");
      response.end('<a href="../../+f/example.whl#sha256=1234">example</a>');
    } else if (path === "/package/-/package.tgz" || path === "/root/pypi/+f/example.whl") {
      response.setHeader("content-type", "application/octet-stream"); response.end(bytes);
    } else { response.writeHead(404); response.end(); }
  });
  const manifest: unknown = await (await fetch(f.npm + "/package")).json();
  expect(manifest).toEqual({ dist: { tarball: f.npm + "/package/-/package.tgz" } });
  expect(Buffer.from(await (await fetch(f.npm + "/package/-/package.tgz")).arrayBuffer())).toEqual(bytes);
  const index = await (await fetch(f.pypi + "/example/")).text();
  const file = new URL(/href="([^"]+)"/.exec(index)![1]!);
  expect(file.origin).toBe(f.pypi); expect(file.hash).toBe("#sha256=1234");
  expect(Buffer.from(await (await fetch(file)).arrayBuffer())).toEqual(bytes);
  expect(received).toContain("/root/pypi/+f/example.whl");
});
