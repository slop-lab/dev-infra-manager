import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerProxy } from "../src/index.js";
import { externalUrlProxy } from "../src/external-url.js";

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
    }> = [];
    const upstream = http.createServer((request, response) => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization
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
    expect((await request(listen, "POST", "/api/urls", { ingress: "tailscale-main" })).status).toBe(201);
    const listed = await request(listen, "GET", "/api/urls");
    expect(JSON.parse(listed.body)).toEqual({ urls: [{ id: "allowed-id", ingress: "tailscale-main" }] });
    expect((await request(listen, "DELETE", "/api/urls/denied-id")).status).toBe(403);
    expect((await request(listen, "DELETE", "/api/urls/allowed-id")).status).toBe(201);
    expect(requests.every((entry) => entry.authorization === "Bearer workspace.secret")).toBe(true);
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
