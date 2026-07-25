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

    const registered = await registerPlugins([createExternalUrlsPlugin({
      proxies: [
        { name: "reverse-proxy-host", listenHost: "127.0.0.1", listenPort: 0 },
        { name: "reverse-proxy-controller", listenHost: "0.0.0.0", listenPort: 0, placement: "controller" }
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
    const tailscale = registered.externalUrlProviders.get("tailscale");
    const cloudflare = registered.externalUrlProviders.get("cloudflare");
    expect(routeProvider && tailscale && cloudflare).toBeTruthy();
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
    const context = { workspace: base.workspace, request: base.request, route } satisfies ExternalUrlProviderContext;
    expect((await tailscale!.publish(context)).url).toBe("http://web--work-1.builder.tail.example.test/");
    expect((await cloudflare!.publish(context)).url).toBe("https://web--work-1.public.example.test/");
  });
});
