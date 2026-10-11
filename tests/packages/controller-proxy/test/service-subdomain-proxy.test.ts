import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControllerProxy } from "../../../../core/packages/controller-proxy/src/index.js";
import { externalUrlProxy } from "../../../../core/packages/controller-proxy/src/external-url.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => Promise.all(cleanup.splice(0).map((operation) => operation())));

it("binds one exact subdomain together with the trusted target", async () => {
  // Given: a dedicated capability for one reviewed service authority.
  const root = await mkdtemp(path.join(tmpdir(), "dim-subdomain-controller-proxy-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const sourceSocket = path.join(root, "source.sock");
  const listen = path.join(root, "proxy.sock");
  const allowedTarget = { containers: ["agent"], protocol: "http" as const, port: 31887 };
  const forwardedBodies: string[] = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    forwardedBodies.push(Buffer.concat(chunks).toString("utf8"));
    if (request.method === "GET" && request.url === "/api") {
      respond(response, { routes: [{ path: "/api/urls", discovery: { ingresses: [
        { name: "https-ts", description: "HTTPS gateway", scheme: "https" }
      ] } }] });
      return;
    }
    if (request.method === "GET" && request.url === "/api/urls") {
      respond(response, { urls: [
        { id: "opencode", ingress: "https-ts", subdomain: "work--opencode", target: allowedTarget },
        { id: "other-slug", ingress: "https-ts", subdomain: "work--other", target: allowedTarget },
        { id: "other-target", ingress: "https-ts", subdomain: "work--opencode", target: { ...allowedTarget, port: 31888 } }
      ] });
      return;
    }
    response.writeHead(201).end('{"ok":true}\n');
  });
  await listenServer(upstream, sourceSocket);
  cleanup.push(() => closeServer(upstream));
  const proxy = createControllerProxy({
    sourceSocket,
    token: "workspace.secret",
    listen,
    capabilities: [externalUrlProxy({
      allowedIngresses: ["https-ts"],
      boundTarget: allowedTarget,
      boundServiceSubdomains: { "opencode-web": "work--opencode" }
    })]
  });
  await proxy.listen();
  cleanup.push(() => proxy.close());

  // When: the caller submits the accepted service and two authority-injection attempts.
  expect((await request(listen, { ingress: "https-ts", service: "opencode-web" })).status).toBe(201);
  expect((await request(listen, { ingress: "https-ts", service: "other" })).status).toBe(403);
  expect((await request(listen, {
    ingress: "https-ts",
    service: "opencode-web",
    subdomain: "work--other"
  })).status).toBe(403);

  // Then: only the exact reviewed authority and target are visible and mutable.
  expect(JSON.parse(forwardedBodies.at(-1) ?? "null")).toEqual({
    ingress: "https-ts",
    subdomain: "work--opencode",
    target: allowedTarget
  });
  expect(JSON.parse((await socketRequest({ socket: listen, method: "GET", path: "/api/urls" })).body)).toEqual({
    urls: [{ id: "opencode", ingress: "https-ts", subdomain: "work--opencode", target: allowedTarget }]
  });
  expect((await socketRequest({ socket: listen, method: "DELETE", path: "/api/urls/other-slug" })).status).toBe(403);
  expect((await socketRequest({ socket: listen, method: "DELETE", path: "/api/urls/other-target" })).status).toBe(403);
  expect((await socketRequest({ socket: listen, method: "DELETE", path: "/api/urls/opencode" })).status).toBe(201);

  const genericListen = path.join(root, "generic-proxy.sock");
  const genericProxy = createControllerProxy({
    sourceSocket,
    token: "workspace.secret",
    listen: genericListen,
    capabilities: [externalUrlProxy({ allowedIngresses: ["https-ts"], boundTarget: allowedTarget })]
  });
  await genericProxy.listen();
  cleanup.push(() => genericProxy.close());
  expect((await request(genericListen, { ingress: "https-ts", service: "generic-http" })).status).toBe(201);
  expect(JSON.parse(forwardedBodies.at(-1) ?? "null")).toEqual({ ingress: "https-ts", target: allowedTarget });
});

function request(socket: string, body: Record<string, unknown>): Promise<{ readonly status: number; readonly body: string }> {
  return socketRequest({ socket, method: "POST", path: "/api/urls", body });
}

function socketRequest(options: {
  readonly socket: string;
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
}): Promise<{ readonly status: number; readonly body: string }> {
  const encoded = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ socketPath: options.socket, method: options.method, path: options.path,
      headers: encoded === undefined ? {} : { "content-type": "application/json" } }, async (response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      resolve({ status: response.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") });
    });
    outgoing.once("error", reject);
    outgoing.end(encoded);
  });
}

function respond(response: http.ServerResponse, body: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function listenServer(server: http.Server, socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
