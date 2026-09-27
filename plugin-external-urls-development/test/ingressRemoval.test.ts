import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredDimAdminController,
  createDimController,
  registerPlugins,
  type LifecycleOptions
} from "@slop-lab/dim-core";
import { createExternalUrlsPlugin, externalUrlsPluginFromConfig } from "../../plugin-external-urls/src/index.js";

const workspace = { id: "project:work", name: "work", projectId: "project", projectName: "project" };

describe("external URL ingress removal", () => {
  const cleanup: Array<() => Promise<void>> = [];
  const originalConfig = process.env.DIM_EXTERNAL_URL_CONFIG;

  afterEach(async () => {
    if (originalConfig === undefined) delete process.env.DIM_EXTERNAL_URL_CONFIG;
    else process.env.DIM_EXTERNAL_URL_CONFIG = originalConfig;
    await Promise.all(cleanup.splice(0).reverse().map((operation) => operation()));
  });

  it("closes the listener and prevents persisted routes from resurrecting after re-add", async () => {
    // Given: a live HTTP ingress with a persisted workspace route.
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-ingress-remove-"));
    cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
    const configPath = path.join(stateRoot, "external-urls.json");
    process.env.DIM_EXTERNAL_URL_CONFIG = configPath;
    const listenPort = await availablePort();
    await writeFile(configPath, `${JSON.stringify({
      schemaVersion: 1,
      dnsProviders: {},
      ingresses: { public: {
        driver: "http",
        description: "Public HTTP",
        scheme: "http",
        argument: JSON.stringify({ domain: "example.test", listenHost: "127.0.0.1", listenPort })
      } }
    })}\n`);
    const target = http.createServer((_request, response) => response.end("reachable"));
    await listen(target);
    cleanup.push(() => close(target));
    const targetAddress = address(target);
    const plugins = await registerPlugins([createExternalUrlsPlugin({ ingresses: { public: {
      description: "Public HTTP",
      scheme: "http",
      domain: "example.test",
      listenHost: "127.0.0.1",
      listenPort
    } } })]);
    cleanup.push(() => plugins.dispose());
    const controller = createDimController({
      stateRoot,
      routes: plugins.controllerRoutes,
      authenticate: async () => workspace,
      resolveTarget: async (_workspace, requested) => ({
        protocol: requested.protocol,
        host: "127.0.0.1",
        port: targetAddress.port,
        fingerprint: "target-generation"
      })
    });
    await listen(controller);
    cleanup.push(() => close(controller));
    const controllerBase = `http://127.0.0.1:${address(controller).port}`;
    expect((await fetch(`${controllerBase}/api/urls`, {
      method: "POST",
      headers: { authorization: "Bearer grant", "content-type": "application/json" },
      body: JSON.stringify({
        ingress: "public",
        subdomain: "work--service",
        target: { containers: ["service"], port: 8080, protocol: "http" }
      })
    })).status).toBe(201);
    expect(await proxyRequest(listenPort)).toBe("reachable");

    // When: admin removes and re-adds the ingress before a plugin restart.
    const admin = configuredDimAdminController({ stateRoot } as LifecycleOptions, plugins);
    await listen(admin);
    cleanup.push(() => close(admin));
    const adminBase = `http://127.0.0.1:${address(admin).port}/v1/external-url`;
    expect((await adminRequest(`${adminBase}/ingress-remove`, { name: "public" })).status).toBe(200);
    await expect(proxyRequest(listenPort)).rejects.toThrow();
    expect((await adminRequest(`${adminBase}/ingress-add`, {
      driver: "http",
      name: "public",
      description: "Public HTTP",
      scheme: "http",
      arguments: [
        "--domain", "example.test",
        "--listen-host", "127.0.0.1",
        "--listen-port", String(listenPort)
      ]
    })).status).toBe(200);
    await plugins.dispose();
    const restarted = await registerPlugins([await externalUrlsPluginFromConfig()]);
    cleanup.push(() => restarted.dispose());
    const initialize = restarted.controllerRoutes.find((route) => route.initialize)?.initialize;
    if (initialize === undefined) throw new Error("missing route initializer");
    const resolveTarget = vi.fn(async () => ({
      protocol: "http" as const,
      host: "127.0.0.1",
      port: targetAddress.port,
      fingerprint: "target-generation"
    }));
    await initialize({
      stateRoot,
      runner: { run: vi.fn(), runStreaming: vi.fn() },
      listWorkspaces: async () => [workspace],
      resolveTarget
    });

    // Then: no removed-ingress claim is reconciled into the fresh listener.
    expect(resolveTarget).not.toHaveBeenCalled();
    await expect(proxyRequest(listenPort)).resolves.toBe("404");
  });
});

function adminRequest(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function proxyRequest(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      headers: { host: "work--service.example.test" }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(
        response.statusCode === 200 ? Buffer.concat(chunks).toString("utf8") : String(response.statusCode)
      ));
    });
    request.once("error", reject);
    request.end();
  });
}

async function availablePort(): Promise<number> {
  const server = http.createServer();
  await listen(server);
  const port = address(server).port;
  await close(server);
  return port;
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function address(server: http.Server): AddressInfo {
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("missing address");
  return value;
}
