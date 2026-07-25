import { once } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  registerPlugins,
  type ExternalRouteProviderContext,
  type ExternalUrlProviderContext
} from "@slop-lab/dev-infra-manager-core";
import { createExternalUrlsPlugin } from "../src/index.js";

describe("external URLs plugin", () => {
  const close: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(close.splice(0).map((item) => item())));

  it("serves any number of workspace routes through tailscale and cloudflare hostnames", async () => {
    const upstream = http.createServer((_request, response) => response.end("workspace app"));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    close.push(() => new Promise((resolve) => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing address");

    const hostProxyPort = await availablePort();
    const controllerProxyPort = await availablePort();
    const registered = await registerPlugins([createExternalUrlsPlugin({
      proxies: [
        { name: "reverse-proxy-host", listenHost: "127.0.0.1", listenPort: hostProxyPort },
        { name: "reverse-proxy-controller", listenHost: "127.0.0.1", listenPort: controllerProxyPort, placement: "controller" }
      ],
      tailscale: { machine: "builder", domain: "tail.example.test", scheme: "http" },
      cloudflare: { domain: "public.example.test" }
    })]);
    close.push(() => registered.dispose());
    expect([...registered.externalRouteProviders.keys()]).toEqual([
      "reverse-proxy-host",
      "reverse-proxy-controller"
    ]);
    const routeProvider = registered.externalRouteProviders.get("reverse-proxy-host");
    const controllerRouteProvider = registered.externalRouteProviders.get("reverse-proxy-controller");
    const tailscale = registered.externalUrlProviders.get("tailscale");
    const cloudflare = registered.externalUrlProviders.get("cloudflare");
    expect(routeProvider && controllerRouteProvider && tailscale && cloudflare).toBeTruthy();
    const base = {
      workspace: { id: "id", name: "work-1", projectId: "pid", projectName: "project" },
      request: { service: "web", port: address.port, protocol: "http" as const },
      upstream: { host: "127.0.0.1", port: address.port, protocol: "http" as const }
    } satisfies ExternalRouteProviderContext;
    const route = {
      id: "route",
      provider: "reverse-proxy-host",
      ...await routeProvider!.provision(base)
    };
    await controllerRouteProvider!.provision(base);
    const context = { workspace: base.workspace, request: base.request, route } satisfies ExternalUrlProviderContext;
    expect((await tailscale!.publish(context)).url).toBe("http://web--work-1.builder.tail.example.test/");
    expect((await cloudflare!.publish(context)).url).toBe("https://web--work-1.public.example.test/");
    expect(await proxyRequest(hostProxyPort, "web--work-1.builder.tail.example.test")).toBe("workspace app");
    expect(await proxyRequest(controllerProxyPort, "web--work-1.builder.tail.example.test")).toBe("workspace app");
    expect(await proxyRequest(hostProxyPort, "unknown.builder.tail.example.test")).toBe("404");
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
