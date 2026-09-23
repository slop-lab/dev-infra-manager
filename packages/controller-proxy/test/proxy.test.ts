import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentControllerProxy, createControllerProxy } from "../../../../core/packages/controller-proxy/src/index.js";
import { externalUrlProxy } from "../../../../core/packages/controller-proxy/src/external-url.js";

describe("controller proxy", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(cleanup.splice(0).map((item) => item())));

  it("injects the trusted grant and restricts External URL routes and ingresses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dim-controller-proxy-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const sourceSocket = path.join(root, "source.sock");
    const listen = path.join(root, "proxy.sock");
    const requests: Array<{
      method: string | undefined;
      path: string | undefined;
      authorization: string | undefined;
      body: string;
    }> = [];
    const upstream = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8")
      });
      if (request.method === "GET" && request.url === "/api") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          apiVersion: 1,
          routes: [
            {
              method: "POST",
              path: "/api/urls",
              discovery: {
                ingresses: [
                  { name: "tailscale-main", description: "Tailnet", scheme: "https" },
                  { name: "public", description: "Public", scheme: "https" }
                ]
              }
            },
            { method: "POST", path: "/api/other" }
          ],
          hostInputProviders: ["builtin.git-author"]
        }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/urls") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          urls: [
            { id: "allowed-id", ingress: "tailscale-main" },
            { id: "denied-id", ingress: "public" }
          ]
        }));
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
      capabilities: [externalUrlProxy({ allowedIngresses: ["tailscale-main"] })]
    });
    await proxy.listen();
    cleanup.push(() => proxy.close());

    const discovery = await request(listen, "GET", "/api");
    expect(JSON.parse(discovery.body)).toMatchObject({
      routes: [{ path: "/api/urls", discovery: { ingresses: [{ name: "tailscale-main" }] } }],
      hostInputProviders: []
    });
    expect((await request(listen, "POST", "/api/host-inputs/builtin.git-author", { key: "name" })).status).toBe(403);
    expect((await request(listen, "POST", "/api/urls", { ingress: "public" })).status).toBe(403);
    const genericRequest = {
      ingress: "tailscale-main",
      target: { containers: ["caller"], protocol: "https", port: 8443 },
      subdomain: "review",
      path: "/service",
      pluginOption: true
    };
    expect((await request(listen, "POST", "/api/urls", genericRequest)).status).toBe(201);
    expect(JSON.parse(requests.at(-1)?.body ?? "null")).toEqual(genericRequest);
    const listed = await request(listen, "GET", "/api/urls");
    expect(JSON.parse(listed.body)).toEqual({ urls: [{ id: "allowed-id", ingress: "tailscale-main" }] });
    expect((await request(listen, "DELETE", "/api/urls/denied-id")).status).toBe(403);
    expect((await request(listen, "DELETE", "/api/urls/allowed-id")).status).toBe(201);
    expect(requests.every((entry) => entry.authorization === "Bearer workspace.secret")).toBe(true);
  });

  it("binds External URL create, list, and revoke operations to one trusted target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dim-target-controller-proxy-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const sourceSocket = path.join(root, "source.sock");
    const listen = path.join(root, "proxy.sock");
    const allowedTarget = { containers: ["agent"], protocol: "tcp" as const, port: 4096 };
    const forwardedBodies: string[] = [];
    const targets = [
      allowedTarget,
      { ...allowedTarget, containers: ["other"] },
      { ...allowedTarget, protocol: "https" },
      { ...allowedTarget, port: 4097 }
    ];
    const upstream = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      forwardedBodies.push(Buffer.concat(chunks).toString("utf8"));
      if (request.method === "GET" && request.url === "/api/urls") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          urls: targets.map((target, index) => ({ id: `url-${index}`, ingress: "https-ts", target }))
        }));
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
        boundTarget: allowedTarget
      })]
    });
    await proxy.listen();
    cleanup.push(() => proxy.close());

    for (const extra of [
      { target: allowedTarget },
      { subdomain: "review" },
      { path: "/service" },
      { pluginOption: true }
    ]) {
      expect((await request(listen, "POST", "/api/urls", {
        ingress: "https-ts",
        ...extra
      })).status).toBe(403);
    }
    expect((await request(listen, "POST", "/api/urls", { ingress: "https-ts" })).status).toBe(201);
    expect(JSON.parse(forwardedBodies.at(-1) ?? "null")).toEqual({
      ingress: "https-ts",
      target: allowedTarget
    });
    expect(JSON.parse((await request(listen, "GET", "/api/urls")).body)).toEqual({
      urls: [{ id: "url-0", ingress: "https-ts", target: allowedTarget }]
    });
    for (const id of ["url-1", "url-2", "url-3"]) {
      expect((await request(listen, "DELETE", `/api/urls/${id}`)).status).toBe(403);
    }
    expect((await request(listen, "DELETE", "/api/urls/url-0")).status).toBe(201);
  });

  it("creates a deny-by-default agent proxy from exact route policies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dim-agent-controller-proxy-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const sourceSocket = path.join(root, "source.sock");
    const listen = path.join(root, "proxy.sock");
    const upstream = http.createServer((request, response) => {
      if (request.method === "GET" && request.url === "/api") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          apiVersion: 1,
          routes: [
            { method: "POST", path: "/api/workspace/restart" },
            { method: "POST", path: "/api/urls" }
          ],
          hostInputProviders: ["builtin.git-author"]
        }));
        return;
      }
      response.writeHead(202).end('{"accepted":true}\n');
    });
    await listenServer(upstream, sourceSocket);
    cleanup.push(() => closeServer(upstream));

    const proxy = createAgentControllerProxy({
      sourceSocket,
      token: "workspace.secret",
      listen,
      routes: [{ method: "POST", path: "/api/workspace/restart" }]
    });
    await proxy.listen();
    cleanup.push(() => proxy.close());

    const discovery = await request(listen, "GET", "/api");
    expect(JSON.parse(discovery.body)).toMatchObject({
      routes: [{ method: "POST", path: "/api/workspace/restart" }],
      hostInputProviders: []
    });
    expect((await request(listen, "POST", "/api/workspace/restart")).status).toBe(202);
    expect((await request(listen, "POST", "/api/workspace/restart", { force: true })).status).toBe(403);
    expect((await request(listen, "POST", "/api/urls")).status).toBe(403);
    expect((await request(listen, "POST", "/api/host-inputs/builtin.git-author", { key: "name" })).status).toBe(403);
  });
});

function listenServer(server: http.Server, socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
}

function request(
  socketPath: string,
  method: string,
  requestPath: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: string }> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      method,
      path: requestPath,
      headers: encoded === undefined ? {} : {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(encoded))
      }
    }, async (response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      resolve({ status: response.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") });
    });
    request.once("error", reject);
    if (encoded !== undefined) request.write(encoded);
    request.end();
  });
}
