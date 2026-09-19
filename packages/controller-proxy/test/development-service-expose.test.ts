import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDevelopmentServiceGateway } from "../../../../core/packages/controller-proxy/src/development-service-gateway.js";
import { exposeDevelopmentService } from "../../../../core/packages/controller-proxy/src/development-service-expose.js";

describe("development service exposure", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(cleanup.splice(0).reverse().map((item) => item())));

  it("sequentially reuses the URL while changing the application port", async () => {
    const fixture = await setup();
    const first = await exposeDevelopmentService(fixture.options(4101));
    const second = await exposeDevelopmentService(fixture.options(4102));

    expect(first).toBe("https://demo.example.test");
    expect(second).toBe(first);
    expect(fixture.posts).toEqual([{ ingress: "https-main" }]);
    expect((await fixture.gateway.getRoute("demo"))?.targetPort).toBe(4102);
  });

  it("serializes simultaneous exposure of the same service into one URL identity", async () => {
    const fixture = await setup();

    const exposed = await Promise.all([
      exposeDevelopmentService(fixture.options(4101)),
      exposeDevelopmentService(fixture.options(4102))
    ]);

    expect(exposed).toEqual(["https://demo.example.test", "https://demo.example.test"]);
    expect(fixture.posts).toEqual([{ ingress: "https-main" }]);
    expect([4101, 4102]).toContain((await fixture.gateway.getRoute("demo"))?.targetPort);
  });

  it("replaces stale state with a newly registered URL", async () => {
    const fixture = await setup();
    await exposeDevelopmentService(fixture.options(4101));
    fixture.urls.splice(0);
    fixture.setNextUrl({
      id: "url-2",
      ingress: "https-main",
      url: "https://replacement.example.test"
    });

    const exposed = await exposeDevelopmentService(fixture.options(4102));

    expect(exposed).toBe("https://replacement.example.test");
    expect(fixture.posts).toHaveLength(2);
    expect((await fixture.gateway.getRoute("demo"))?.urlId).toBe("url-2");
  });

  it("rejects an ingress whose discovered scheme does not meet the requirement", async () => {
    const fixture = await setup("http");

    await expect(exposeDevelopmentService(fixture.options(4101))).rejects.toThrow("requires scheme https");

    expect(fixture.posts).toEqual([]);
  });

  async function setup(scheme: "http" | "https" = "https") {
    const root = await mkdtemp(path.join(tmpdir(), "dim-development-expose-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const developmentUrlSocket = path.join(root, "development.sock");
    const stateDirectory = path.join(root, "state");
    const urls: Array<{ id: string; ingress: string; url: string }> = [];
    const posts: Array<Record<string, unknown>> = [];
    let nextUrl = { id: "url-1", ingress: "https-main", url: "https://demo.example.test" };
    const controller = http.createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/api") {
        json(response, 200, { routes: [{ path: "/api/urls", discovery: {
          ingresses: [{ name: "https-main", description: "test", scheme }]
        } }] });
        return;
      }
      if (request.method === "GET" && request.url === "/api/urls") {
        json(response, 200, { urls });
        return;
      }
      if (request.method === "POST" && request.url === "/api/urls") {
        const body = await readJson(request);
        posts.push(body);
        urls.push(nextUrl);
        json(response, 201, { urls: [nextUrl] });
        return;
      }
      response.writeHead(404).end();
    });
    await listenSocket(controller, developmentUrlSocket);
    cleanup.push(() => closeServer(controller));
    const gateway = createDevelopmentServiceGateway({ listenPort: 0, stateDirectory });
    await gateway.listen();
    cleanup.push(() => gateway.close());
    return {
      urls,
      posts,
      setNextUrl: (value: { id: string; ingress: string; url: string }) => {
        nextUrl = value;
      },
      gateway,
      options: (targetPort: number) => ({
        name: "demo",
        targetPort,
        ingress: "https-main",
        requiredScheme: "https" as const,
        developmentUrlSocket,
        gatewayControlSocket: gateway.controlSocket
      })
    };
  }
});

function listenSocket(server: http.Server, socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object");
  return Object.fromEntries(Object.entries(value));
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
