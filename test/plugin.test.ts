import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { EXTERNAL_URL_INGRESS_DRIVER_EXTENSION } from "../../plugin-external-urls/src/tailscale.js";

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
    expect(registered.host.extension(EXTERNAL_URL_INGRESS_DRIVER_EXTENSION, "tailscale")).toBeDefined();
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

  it("isolates a stored route reconciliation failure from the remaining routes", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-external-urls-reconcile-"));
    close.push(() => rm(stateRoot, { recursive: true, force: true }));
    const workspace = {
      id: "project-id:work-1",
      name: "work-1",
      projectId: "project-id",
      projectName: "project"
    };
    const directory = path.join(
      stateRoot,
      "plugins",
      "external-urls",
      Buffer.from(workspace.id).toString("base64url")
    );
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "00000000-0000-4000-8000-000000000000.json"), JSON.stringify({
      id: "00000000-0000-4000-8000-000000000000",
      workspace: workspace.name,
      workspaceId: workspace.id,
      ingress: "removed",
      subdomain: "broken",
      target: { containers: ["broken"], port: 8080, protocol: "http" },
      route: { id: "broken-route", ingress: "removed", authority: "broken.example.test" },
      url: "http://broken.example.test/",
      createdAt: "2026-08-25T00:00:00.000Z"
    }));
    await writeFile(path.join(directory, "11111111-1111-4111-8111-111111111111.json"), JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111",
      workspace: workspace.name,
      workspaceId: workspace.id,
      ingress: "public",
      subdomain: "healthy",
      target: { containers: ["healthy"], port: 8080, protocol: "http" },
      route: { id: "healthy-route", ingress: "public", authority: "healthy.example.test" },
      url: "http://healthy.example.test/",
      createdAt: "2026-08-25T00:00:00.000Z"
    }));
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const registered = await registerPlugins([createExternalUrlsPlugin({
      ingresses: {
        public: {
          description: "Public HTTP",
          scheme: "http",
          domain: "example.test",
          listenHost: "127.0.0.1",
          listenPort: 0
        }
      }
    })], { logger });
    close.push(() => registered.dispose());
    const initialize = registered.controllerRoutes.find((route) => route.initialize)?.initialize;
    expect(initialize).toBeDefined();
    const resolveTarget = vi.fn(async () => ({
      protocol: "http" as const,
      host: "127.0.0.1",
      port: 8080,
      fingerprint: "target-generation"
    }));
    const runner = new RecordingRunner();

    await expect(initialize!({
      stateRoot,
      runner: {
        run: runner.run.bind(runner),
        runStreaming: vi.fn(async () => 0)
      },
      listWorkspaces: async () => [workspace],
      resolveTarget
    })).resolves.toBeUndefined();

    expect(resolveTarget).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith("DIM external URL route reconciliation failed", {
      workspace: "work-1",
      route: "broken-route",
      ingress: "removed",
      error: "external URL ingress 'removed' is not configured"
    });
  });

  it("reconciles a persisted route to a recreated workspace upstream before listing it", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-external-urls-recreated-"));
    close.push(() => rm(stateRoot, { recursive: true, force: true }));
    const firstUpstream = http.createServer((_request, response) => response.end("first generation"));
    firstUpstream.listen(0, "127.0.0.1");
    await once(firstUpstream, "listening");
    close.push(() => new Promise((resolve) => firstUpstream.close(() => resolve())));
    const secondUpstream = http.createServer((_request, response) => response.end("second generation"));
    secondUpstream.listen(0, "127.0.0.1");
    await once(secondUpstream, "listening");
    close.push(() => new Promise((resolve) => secondUpstream.close(() => resolve())));
    const firstAddress = firstUpstream.address();
    const secondAddress = secondUpstream.address();
    if (!firstAddress || typeof firstAddress === "string" || !secondAddress || typeof secondAddress === "string") {
      throw new Error("missing upstream address");
    }
    const proxyPort = await availablePort();
    const registered = await registerPlugins([createExternalUrlsPlugin({
      ingresses: {
        public: {
          description: "Public HTTP",
          scheme: "http",
          domain: "example.test",
          listenHost: "127.0.0.1",
          listenPort: proxyPort
        }
      }
    })]);
    close.push(() => registered.dispose());
    let currentPort = firstAddress.port;
    const workspace = {
      id: "project-id:work-1",
      name: "work-1",
      projectId: "project-id",
      projectName: "project"
    };
    const controller = createDimController({
      stateRoot,
      routes: registered.controllerRoutes,
      authenticate: async () => workspace,
      resolveTarget: async (_workspace, target) => ({
        protocol: "http",
        host: "127.0.0.1",
        port: target.port === 9999 ? firstAddress.port : currentPort,
        fingerprint: `target:${target.port === 9999 ? firstAddress.port : currentPort}`
      })
    });
    controller.listen(0, "127.0.0.1");
    await once(controller, "listening");
    close.push(() => new Promise((resolve) => controller.close(() => resolve())));
    const controllerAddress = controller.address();
    if (!controllerAddress || typeof controllerAddress === "string") throw new Error("missing controller address");
    const base = `http://127.0.0.1:${controllerAddress.port}`;
    const headers = { authorization: "Bearer grant", "content-type": "application/json" };

    const created = await fetch(`${base}/api/urls`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ingress: "public",
        subdomain: "work-1--service",
        target: { containers: ["agent"], port: 31887 }
      })
    });
    expect(created.status).toBe(201);
    const createdBody = externalUrlResponse(await created.json());
    expect(await proxyRequest(proxyPort, "work-1--service.example.test")).toBe("first generation");

    currentPort = secondAddress.port;
    const listed = await fetch(`${base}/api/urls`, { headers });

    expect(listed.status).toBe(200);
    expect(externalUrlResponse(await listed.json()).urls).toEqual(createdBody.urls);
    expect(await proxyRequest(proxyPort, "work-1--service.example.test")).toBe("second generation");

    const conflicting = await fetch(`${base}/api/urls`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ingress: "public",
        subdomain: "work-1--service",
        target: { containers: ["other"], port: 9999 }
      })
    });
    expect(conflicting.status).toBe(400);
    expect(await proxyRequest(proxyPort, "work-1--service.example.test")).toBe("second generation");
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
      port: upstreamAddress.port,
      fingerprint: "target-generation"
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
    })).toThrow(/scheme must be http, https, or tcp/);
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

function externalUrlResponse(value: unknown): { readonly urls: readonly { readonly id: string; readonly url: string }[] } {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("urls" in value) || !Array.isArray(value.urls)) {
    throw new Error("expected external URL response");
  }
  const urls = value.urls.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || !("id" in entry) || typeof entry.id !== "string"
      || !("url" in entry) || typeof entry.url !== "string") {
      throw new Error("expected external URL entry");
    }
    return { id: entry.id, url: entry.url };
  });
  return { urls };
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
