import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredDimAdminController,
  createDimController,
  DIM_PLUGIN_API_VERSION,
  initializeControllerRoutes,
  RecordingRunner,
  registerPlugins,
  type LifecycleOptions
} from "@slop-lab/dim-core";
import {
  EXTERNAL_URL_DNS_PROVIDER_EXTENSION,
  type ExternalUrlDnsProviderDriver
} from "@slop-lab/dim-contracts-external-url";
import { createExternalUrlsPlugin, externalUrlsPluginFromConfig } from "../../plugin-external-urls/src/index.js";

describe("external URLs plugin", () => {
  const close: Array<() => Promise<void>> = [];
  const originalExternalUrlConfig = process.env.DIM_EXTERNAL_URL_CONFIG;
  afterEach(async () => {
    if (originalExternalUrlConfig === undefined) delete process.env.DIM_EXTERNAL_URL_CONFIG;
    else process.env.DIM_EXTERNAL_URL_CONFIG = originalExternalUrlConfig;
    await Promise.all(close.splice(0).map((item) => item()));
  });

  it("marks every workspace URL route safe for the scoped agent controller", async () => {
    const registered = await registerPlugins([createExternalUrlsPlugin({ ingresses: {} })]);
    close.push(() => registered.dispose());
    expect(registered.controllerRoutes).toHaveLength(4);
    expect(registered.controllerRoutes.every((route) =>
      route.audiences.includes("workspace") && route.audiences.includes("agent")))
      .toBe(true);
  });

  it("reports ingress argument mistakes as actionable client errors", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-external-urls-admin-"));
    close.push(() => rm(stateRoot, { recursive: true, force: true }));
    process.env.DIM_EXTERNAL_URL_CONFIG = path.join(stateRoot, "external-urls.json");
    const driver: ExternalUrlDnsProviderDriver = {
      parseProviderArguments: (arguments_) => arguments_.join(" "),
      normalizeProviderArgument: (argument) => `provider:${argument}`,
      normalizeRecordArgument: (argument) => `record:${argument}`,
      ensure: vi.fn(),
      verify: vi.fn(),
      remove: vi.fn(),
      caddyDns01: () => ({ modules: [], directive: "dns example", environment: {} })
    };
    const registered = await registerPlugins([createExternalUrlsPlugin({ ingresses: {} }), {
      name: "@example/dim-plugin-dns",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) {
        host.registerExtension(EXTERNAL_URL_DNS_PROVIDER_EXTENSION, "example", driver);
      }
    }]);
    close.push(() => registered.dispose());
    const server = configuredDimAdminController({ stateRoot } as LifecycleOptions, registered);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    close.push(() => new Promise((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const base = `http://127.0.0.1:${address.port}/v1/external-url`;
    const endpoint = `${base}/ingress-add`;

    const missingDriver = await fetch(`${base}/dns-provider-add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        driver: "missing",
        name: "missing",
        arguments: []
      })
    });
    expect(missingDriver.status).toBe(400);
    expect((await missingDriver.json() as { error: string }).error).toContain(
      "DNS provider driver 'missing' is not installed"
    );

    const providerResponse = await fetch(`${base}/dns-provider-add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        driver: "example",
        name: "example-main",
        arguments: ["connection"]
      })
    });
    expect(providerResponse.status).toBe(200);

    const request = (scheme: "http" | "https", arguments_: string[], driver = "http") =>
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          driver,
          name: "test",
          description: "Test ingress",
          scheme,
          arguments: arguments_
        })
      });

    const unknownArgument = await request("http", ["--unknown", "value"]);
    expect(unknownArgument.status).toBe(400);
    expect((await unknownArgument.json() as { error: string }).error).toContain("unknown http ingress argument");

    const missingDomain = await request("http", ["--listen-host", "0.0.0.0", "--listen-port", "auto"]);
    expect(missingDomain.status).toBe(400);
    expect((await missingDomain.json() as { error: string }).error).toContain("docs/external-urls.md#named-ingresses");

    const caddyHttp = await request("http", [], "caddy");
    expect(caddyHttp.status).toBe(400);
    expect((await caddyHttp.json() as { error: string }).error).toContain(
      "docs/external-urls.md#http-and-https-with-cloudflare-dns-and-caddy"
    );

    const missingDnsProvider = await request(
      "https",
      ["--domain", "remote.example.com", "--listen-host", "127.0.0.1", "--listen-port", "9443",
        "--dns-provider", "missing", "--dns-argument", "{}"],
      "caddy"
    );
    expect(missingDnsProvider.status).toBe(400);
    expect(await missingDnsProvider.json()).toEqual({
      error: "DNS provider 'missing' is not configured; run 'dim external-url dns-provider add --help' first"
    });

    const configuredCaddy = await request(
      "https",
      ["--domain", "remote.example.com", "--listen-host", "127.0.0.1", "--listen-port", "9443",
        "--dns-provider", "example-main", "--dns-argument", "record configuration"],
      "caddy"
    );
    expect(configuredCaddy.status).toBe(200);
    const providers = await fetch(`${base}/dns-provider-list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(await providers.json()).toEqual([{ name: "example-main", driver: "example" }]);
  });

  it("automatically reconciles managed Caddy without storing its router port", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-external-urls-caddy-"));
    close.push(() => rm(stateRoot, { recursive: true, force: true }));
    const configPath = path.join(stateRoot, "external-urls.json");
    process.env.DIM_EXTERNAL_URL_CONFIG = configPath;
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      dnsProviders: {
        "example-main": {
          driver: "example",
          argument: "provider configuration"
        }
      },
      ingresses: {
        public: {
          driver: "caddy",
          description: "Managed HTTPS",
          scheme: "https",
          argument: JSON.stringify({
            domain: "remote.example.com",
            listenHost: "127.0.0.1",
            listenPort: 9443,
            dnsProvider: "example-main",
            dnsArgument: "record configuration",
            staticRoutes: [{ subdomain: "git", upstream: "http://127.0.0.1:3300" }]
          })
        }
      }
    }));
    const ensure = vi.fn();
    const driver: ExternalUrlDnsProviderDriver = {
      normalizeProviderArgument: (argument) => argument,
      normalizeRecordArgument: (argument) => argument,
      ensure,
      verify: vi.fn(),
      remove: vi.fn(),
      caddyDns01: () => ({
        modules: ["example.test/caddy-dns"],
        directive: "dns example",
        environment: { EXAMPLE_TOKEN: "secret" }
      })
    };
    const registered = await registerPlugins([{
      name: "@example/dim-plugin-dns",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) {
        host.registerExtension(EXTERNAL_URL_DNS_PROVIDER_EXTENSION, "example", driver);
      }
    }, await externalUrlsPluginFromConfig()]);
    close.push(() => registered.dispose());
    const runner = new RecordingRunner();
    const streamingRunner = {
      run: runner.run.bind(runner),
      runStreaming: vi.fn(async () => 0)
    };
    await initializeControllerRoutes({
      stateRoot,
      defaultWorkspaceBackend: "sysbox"
    } as LifecycleOptions, registered, streamingRunner);

    expect(ensure).toHaveBeenCalledOnce();
    expect(runner.commands).toContainEqual({
      command: "docker",
      args: expect.arrayContaining(["compose", "up", "--detach", "--build"]),
      sudo: false
    });
    const stored = JSON.parse(await readFile(configPath, "utf8")) as {
      ingresses: { public: { argument: string } };
    };
    expect(JSON.parse(stored.ingresses.public.argument)).not.toHaveProperty("internalPort");
    const caddyfile = await readFile(
      path.join(stateRoot, "plugins", "external-urls", "caddy", "public", "Caddyfile"),
      "utf8"
    );
    expect(caddyfile).toMatch(/reverse_proxy 127\.0\.0\.1:\d+/);
    expect(caddyfile).toContain("host git.remote.example.com");
    expect(caddyfile).toContain("reverse_proxy http://127.0.0.1:3300");
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
    let upstreamHeaders: http.IncomingHttpHeaders | undefined;
    const upstream = http.createServer((request, response) => {
      upstreamHeaders = request.headers;
      response.end("nested workspace app");
    });
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
          domain: "builder.tail.example.test",
          listenHost: "127.0.0.1",
          listenPort: controllerProxyPort,
          upstreamMode: "container-ip"
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

    const automatic = await Promise.all([8080, 8081].map((port) => fetch(`${base}/api/urls`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        ingress: "tailnet",
        target: { containers: ["dev"], port }
      })
    }).then(async (response) => {
      expect(response.status).toBe(201);
      return response.json() as Promise<{ urls: Array<{ id: string; subdomain: string }> }>;
    })));
    expect(automatic.map((result) => result.urls[0]?.subdomain).sort()).toEqual(["work-1--0", "work-1--1"]);
    for (const result of automatic) {
      expect((await fetch(`${base}/api/urls/${result.urls[0]?.id}`, {
        method: "DELETE",
        headers
      })).status).toBe(204);
    }

    const missingIngress = await fetch(`${base}/api/urls`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ subdomain: "work-1--dev", target: { containers: ["dev"], port: 8080 } })
    });
    expect(missingIngress.status).toBe(400);

    const created = await fetch(`${base}/api/urls`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        ingress: "tailnet",
        subdomain: "work-1--deep",
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
    expect(await proxyRequest(
      hostProxyPort,
      "work-1--deep.builder.tail.example.test",
      { "x-forwarded-proto": "spoofed" }
    )).toBe("nested workspace app");
    expect(upstreamHeaders?.["x-forwarded-proto"]).toBe("http");
    expect(upstreamHeaders?.["x-forwarded-host"]).toBe("work-1--deep.builder.tail.example.test");
    expect(await proxyRequest(controllerProxyPort, "work-1--deep.builder.tail.example.test")).toBe("nested workspace app");
    expect(await proxyRequest(hostProxyPort, "unknown.builder.tail.example.test")).toBe("404");

    const secondFrontend = await fetch(`${base}/api/urls`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        ingress: "public",
        subdomain: "work-1--deep",
        target: { containers: ["dev", "deep"], port: 8080 }
      })
    });
    expect(secondFrontend.status).toBe(201);
    const secondBody = await secondFrontend.json() as { urls: Array<{ id: string; url: string }> };
    expect(secondBody.urls[0]?.url).toBe("https://work-1--deep.builder.tail.example.test/");

    const rejected = await fetch(`${base}/api/urls`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        ingress: "tailnet",
        subdomain: "docs",
        target: { containers: [], port: 8080 }
      })
    });
    expect(rejected.status).toBe(400);
    expect((await rejected.json() as { error: string }).error).toContain("must start with 'work-1--'");

    const listed = await fetch(`${base}/api/urls`, { headers });
    expect((await listed.json() as { urls: unknown[] }).urls).toHaveLength(2);
    expect((await fetch(`${base}/api/urls/${body.urls[0]?.id}`, {
      method: "DELETE",
      headers
    })).status).toBe(204);
    expect(await proxyRequest(controllerProxyPort, "work-1--deep.builder.tail.example.test")).toBe("nested workspace app");
    expect((await fetch(`${base}/api/urls/${secondBody.urls[0]?.id}`, {
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

async function proxyRequest(
  port: number,
  host: string,
  headers: http.OutgoingHttpHeaders = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      headers: { ...headers, host }
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
