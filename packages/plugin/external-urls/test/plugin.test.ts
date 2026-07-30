import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredDimAdminController,
  createDimController,
  registerPlugins,
  type LifecycleOptions
} from "@slop-lab/dim-core";
import { createExternalUrlsPlugin } from "../src/index.js";

describe("external URLs plugin", () => {
  const close: Array<() => Promise<void>> = [];
  const originalExternalUrlConfig = process.env.DIM_EXTERNAL_URL_CONFIG;
  afterEach(async () => {
    if (originalExternalUrlConfig === undefined) delete process.env.DIM_EXTERNAL_URL_CONFIG;
    else process.env.DIM_EXTERNAL_URL_CONFIG = originalExternalUrlConfig;
    await Promise.all(close.splice(0).map((item) => item()));
  });

  it("reports ingress argument mistakes as actionable client errors", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-external-urls-admin-"));
    close.push(() => rm(stateRoot, { recursive: true, force: true }));
    process.env.DIM_EXTERNAL_URL_CONFIG = path.join(stateRoot, "external-urls.json");
    const registered = await registerPlugins([createExternalUrlsPlugin({ ingresses: {} })]);
    close.push(() => registered.dispose());
    const server = configuredDimAdminController({} as LifecycleOptions, registered);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    close.push(() => new Promise((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const endpoint = `http://127.0.0.1:${address.port}/v1/external-url/ingress-add`;

    const request = (scheme: "http" | "https", argument: string, driver = "builtin-http") =>
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          driver,
          name: "test",
          description: "Test ingress",
          scheme,
          argument
        })
      });

    const invalidJson = await request("http", "");
    expect(invalidJson.status).toBe(400);
    expect((await invalidJson.json() as { error: string }).error).toContain("docs/external-urls.md#named-ingresses");

    const missingDomain = await request("http", '{"listenHost":"0.0.0.0","listenPort":"auto"}');
    expect(missingDomain.status).toBe(400);
    expect((await missingDomain.json() as { error: string }).error).toContain("docs/external-urls.md#named-ingresses");

    const caddyHttp = await request("http", "{}", "caddy");
    expect(caddyHttp.status).toBe(400);
    expect((await caddyHttp.json() as { error: string }).error).toContain(
      "docs/external-urls.md#http-and-https-with-cloudflare-dns-and-caddy"
    );

    const invalidCaddyJson = await request("https", "", "caddy");
    expect(invalidCaddyJson.status).toBe(400);
    expect((await invalidCaddyJson.json() as { error: string }).error).toContain(
      "docs/external-urls.md#http-and-https-with-cloudflare-dns-and-caddy"
    );
  });

  it("starts normally without a configured ingress", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-external-urls-empty-"));
    close.push(() => rm(stateRoot, { recursive: true, force: true }));
    const registered = await registerPlugins([createExternalUrlsPlugin({ ingresses: {} })]);
    close.push(() => registered.dispose());
    const controller = createDimController({
      stateRoot,
      routes: registered.controllerRoutes,
      authenticate: async () => ({ id: "id", name: "work-1", projectId: "pid", projectName: "project" }),
      resolveTarget: async () => {
        throw new Error("an empty ingress configuration must not resolve targets");
      }
    });
    controller.listen(0, "127.0.0.1");
    await once(controller, "listening");
    close.push(() => new Promise((resolve) => controller.close(() => resolve())));
    const address = controller.address();
    if (!address || typeof address === "string") throw new Error("missing controller address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api`, {
      headers: { authorization: "Bearer grant" }
    });
    expect(response.status).toBe(200);
    const discovery = await response.json() as {
      routes: Array<{ path: string; discovery?: { ingresses?: unknown[] } }>;
    };
    expect(discovery.routes.find((route) => route.path === "/api/urls")?.discovery?.ingresses).toEqual([]);
  });

  it("discovers host ingresses and proxies controller-selected nested targets", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-external-urls-"));
    close.push(() => rm(stateRoot, { recursive: true, force: true }));
    const upstream = http.createServer((_request, response) => response.end("nested workspace app"));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    close.push(() => new Promise((resolve) => upstream.close(() => resolve())));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("missing address");

    const hostProxyPort = await availablePort();
    const controllerProxyPort = await availablePort();
    const registered = await registerPlugins([createExternalUrlsPlugin({
      ingresses: {
        tailnet: {
          description: "Tailnet development URL",
          scheme: "http",
          domain: "builder.tail.example.test",
          listenHost: "127.0.0.1",
          listenPort: hostProxyPort,
          upstreamMode: "container-ip"
        },
        public: {
          description: "Public preview URL",
          scheme: "https",
          domain: "public.example.test",
          listenHost: "127.0.0.1",
          listenPort: controllerProxyPort,
          upstreamMode: "container-dns"
        }
      }
    })]);
    close.push(() => registered.dispose());

    const resolveTarget = vi.fn(async () => ({
      protocol: "http" as const,
      host: "127.0.0.1",
      port: upstreamAddress.port
    }));
    const controller = createDimController({
      stateRoot,
      routes: registered.controllerRoutes,
      authenticate: async () => ({ id: "id", name: "work-1", projectId: "pid", projectName: "project" }),
      resolveTarget
    });
    controller.listen(0, "127.0.0.1");
    await once(controller, "listening");
    close.push(() => new Promise((resolve) => controller.close(() => resolve())));
    const controllerAddress = controller.address();
    if (!controllerAddress || typeof controllerAddress === "string") throw new Error("missing controller address");
    const base = `http://127.0.0.1:${controllerAddress.port}`;
    const headers = { authorization: "Bearer grant" };

    const discovery = await fetch(`${base}/api`, { headers });
    const discovered = await discovery.json() as {
      routes: Array<{ path: string; discovery?: { ingresses?: Array<{ name: string }> } }>;
    };
    expect(discovered.routes.find((route) => route.path === "/api/urls")?.discovery?.ingresses).toEqual([
      { name: "tailnet", description: "Tailnet development URL", scheme: "http" },
      { name: "public", description: "Public preview URL", scheme: "https" }
    ]);

    const missingIngress = await fetch(`${base}/api/urls`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ service: "dev", target: { containers: ["dev"], port: 8080 } })
    });
    expect(missingIngress.status).toBe(400);

    const created = await fetch(`${base}/api/urls`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        ingress: "tailnet",
        service: "deep",
        target: { containers: ["dev", "deep"], port: 8080 }
      })
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { urls: Array<{ id: string; url: string }> };
    expect(body.urls[0]?.url).toBe("http://work-1--deep.builder.tail.example.test/");
    expect(resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ name: "work-1" }),
      { containers: ["dev", "deep"], port: 8080, protocol: "http" },
      "container-ip"
    );
    expect(await proxyRequest(hostProxyPort, "work-1--deep.builder.tail.example.test")).toBe("nested workspace app");
    expect(await proxyRequest(hostProxyPort, "unknown.builder.tail.example.test")).toBe("404");

    const listed = await fetch(`${base}/api/urls`, { headers });
    expect((await listed.json() as { urls: unknown[] }).urls).toHaveLength(1);
    expect((await fetch(`${base}/api/urls/${body.urls[0]?.id}`, {
      method: "DELETE",
      headers
    })).status).toBe(204);
  });

  it("rejects invalid ingress configuration", () => {
    expect(() => createExternalUrlsPlugin({
      ingresses: {
        invalid: {
          description: "Invalid URL",
          scheme: "ftp" as "https",
          domain: "example.test",
          listenHost: "0.0.0.0",
          listenPort: 8080
        }
      }
    })).toThrow(/scheme must be http or https/);
  });

});

async function availablePort(): Promise<number> {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function proxyRequest(port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      headers: { host }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve(response.statusCode === 200 ? Buffer.concat(chunks).toString("utf8") : String(response.statusCode));
      });
    });
    request.on("error", reject);
    request.end();
  });
}
