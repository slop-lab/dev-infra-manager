import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDimController,
  registerPlugins
} from "@slop-lab/dev-infra-manager-core";
import { createExternalUrlsPlugin } from "../src/index.js";

describe("external URLs plugin", () => {
  const close: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(close.splice(0).map((item) => item())));

  it("discovers host profiles and proxies controller-selected nested targets", async () => {
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
      proxies: [
        { name: "host-proxy", listenHost: "127.0.0.1", listenPort: hostProxyPort, upstreamMode: "container-ip" },
        { name: "controller-proxy", listenHost: "127.0.0.1", listenPort: controllerProxyPort, upstreamMode: "container-dns" }
      ],
      tailscale: { machine: "builder", domain: "tail.example.test", scheme: "http" },
      cloudflare: { domain: "public.example.test" },
      profiles: {
        tailnet: {
          description: "Tailnet development URL",
          protocol: "http"
        },
        public: {
          description: "Public preview URL",
          protocol: "https"
        }
      },
      bindings: {
        tailnet: {
          routeProvider: "host-proxy",
          urlProvider: "tailscale"
        },
        public: {
          routeProvider: "controller-proxy",
          urlProvider: "cloudflare"
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
      routes: Array<{ path: string; discovery?: { profiles?: Array<{ name: string }> } }>;
    };
    expect(discovered.routes.find((route) => route.path === "/api/urls")?.discovery?.profiles).toEqual([
      { name: "tailnet", description: "Tailnet development URL", protocol: "http" },
      { name: "public", description: "Public preview URL", protocol: "https" }
    ]);

    const missingProfile = await fetch(`${base}/api/urls`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ service: "dev", target: { containers: ["dev"], port: 8080 } })
    });
    expect(missingProfile.status).toBe(400);

    const created = await fetch(`${base}/api/urls`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        profile: "tailnet",
        service: "deep",
        target: { containers: ["dev", "deep"], port: 8080 }
      })
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { urls: Array<{ id: string; url: string }> };
    expect(body.urls[0]?.url).toBe("http://deep--work-1.builder.tail.example.test/");
    expect(resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ name: "work-1" }),
      { containers: ["dev", "deep"], port: 8080, protocol: "http" },
      "container-ip"
    );
    expect(await proxyRequest(hostProxyPort, "deep--work-1.builder.tail.example.test")).toBe("nested workspace app");
    expect(await proxyRequest(hostProxyPort, "unknown.builder.tail.example.test")).toBe("404");

    const listed = await fetch(`${base}/api/urls`, { headers });
    expect((await listed.json() as { urls: unknown[] }).urls).toHaveLength(1);
    expect((await fetch(`${base}/api/urls/${body.urls[0]?.id}`, {
      method: "DELETE",
      headers
    })).status).toBe(204);
  });

  it("rejects tailscale profiles backed by a non-host proxy", () => {
    expect(() => createExternalUrlsPlugin({
      proxies: [{
        name: "controller-proxy",
        listenHost: "0.0.0.0",
        listenPort: 8080,
        upstreamMode: "container-dns"
      }],
      tailscale: { machine: "builder", domain: "tail.example.test" },
      profiles: {
        invalid: {
          description: "Invalid Tailnet URL",
          protocol: "https"
        }
      },
      bindings: {
        invalid: {
          routeProvider: "controller-proxy",
          urlProvider: "tailscale"
        }
      }
    })).toThrow(/must use a host-reachable reverse proxy/);
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
