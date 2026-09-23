import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDimController, RecordingRunner, registerPlugins } from "@slop-lab/dim-core";
import { createExternalUrlsPlugin } from "../../plugin-external-urls/src/index.js";
import { tailscaleIngressDriver, tailscaleSelfAddress } from "../../plugin-external-urls/src/tailscale.js";

describe("TCP external ingress", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).reverse().map((operation) => operation()));
  });

  it("forwards raw TCP only after an authenticated scoped target claim", async () => {
    // Given: a raw TCP target and a host-owned TCP ingress.
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-tcp-ingress-"));
    cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
    const target = net.createServer((socket) => socket.pipe(socket));
    await listen(target);
    cleanup.push(() => close(target));
    const targetAddress = address(target);
    const listenPort = await availablePort();
    const registered = await registerPlugins([createExternalUrlsPlugin({
      ingresses: {
        "tailnet-ssh": {
          description: "Tailnet SSH",
          scheme: "tcp",
          domain: "127.0.0.1",
          listenHost: "127.0.0.1",
          listenPort,
          upstreamMode: "container-ip"
        }
      }
    })]);
    cleanup.push(() => registered.dispose());
    const workspace = { id: "project:work", name: "work", projectId: "project", projectName: "project" };
    const controller = createDimController({
      stateRoot,
      routes: registered.controllerRoutes,
      authenticate: async (token) => token === "valid" ? workspace : undefined,
      resolveTarget: async (_workspace, requested) => ({
        protocol: requested.protocol,
        host: "127.0.0.1",
        port: targetAddress.port,
        fingerprint: "target-generation"
      })
    });
    await listen(controller);
    cleanup.push(() => close(controller));
    const base = `http://127.0.0.1:${address(controller).port}`;

    // When: an invalid grant attempts the claim, then the valid workspace claims it.
    const denied = await fetch(`${base}/api/urls`, {
      method: "POST",
      headers: { authorization: "Bearer invalid", "content-type": "application/json" },
      body: JSON.stringify({ ingress: "tailnet-ssh", target: { containers: ["dev"], port: 22, protocol: "tcp" } })
    });
    const created = await fetch(`${base}/api/urls`, {
      method: "POST",
      headers: { authorization: "Bearer valid", "content-type": "application/json" },
      body: JSON.stringify({ ingress: "tailnet-ssh", target: { containers: ["dev"], port: 22, protocol: "tcp" } })
    });

    // Then: authentication fails closed and bytes traverse the claimed listener.
    expect(denied.status).toBe(401);
    expect(created.status).toBe(201);
    expect(await exchange(listenPort, "ssh-probe")).toBe("ssh-probe");
    const body = await created.json() as { readonly urls: readonly [{ readonly id: string; readonly url: string }] };
    expect(body.urls[0].url).toBe(`tcp://127.0.0.1:${listenPort}`);
    expect((await fetch(`${base}/api/urls/${body.urls[0].id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer valid" }
    })).status).toBe(204);
    await expect(exchange(listenPort, "revoked")).rejects.toThrow();
  });

  it("rejects a second target and a second owner of the same listener", async () => {
    // Given: one claimed TCP ingress.
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-tcp-collision-"));
    cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
    const listenPort = await availablePort();
    const options = {
      ingresses: {
        tcp: {
          description: "TCP",
          scheme: "tcp" as const,
          domain: "127.0.0.1",
          listenHost: "127.0.0.1",
          listenPort
        }
      }
    };
    const registered = await registerPlugins([createExternalUrlsPlugin(options)]);
    cleanup.push(() => registered.dispose());
    const workspace = { id: "project:work", name: "work", projectId: "project", projectName: "project" };
    const controller = createDimController({
      stateRoot,
      routes: registered.controllerRoutes,
      authenticate: async () => workspace,
      resolveTarget: async (_workspace, target) => ({
        protocol: target.protocol,
        host: "127.0.0.1",
        port: target.port,
        fingerprint: `target:${target.port}`
      })
    });
    await listen(controller);
    cleanup.push(() => close(controller));
    const base = `http://127.0.0.1:${address(controller).port}`;
    const request = (port: number) => fetch(`${base}/api/urls`, {
      method: "POST",
      headers: { authorization: "Bearer valid", "content-type": "application/json" },
      body: JSON.stringify({ ingress: "tcp", target: { containers: ["dev"], port, protocol: "tcp" } })
    });
    expect((await request(22)).status).toBe(201);

    // When: another target and another plugin instance attempt the owned port.
    const conflictingTarget = await request(23);
    const secondOwner = registerPlugins([createExternalUrlsPlugin(options)]);

    // Then: neither can replace the existing listener or target.
    expect(conflictingTarget.status).toBe(400);
    await expect(secondOwner).rejects.toThrow(/address already in use/i);
  });

  it("reconciles a persisted claim after controller restart", async () => {
    // Given: a persisted route created by the first plugin instance.
    const stateRoot = await mkdtemp(path.join(tmpdir(), "dim-tcp-restart-"));
    cleanup.push(() => rm(stateRoot, { recursive: true, force: true }));
    const listenPort = await availablePort();
    const options = { ingresses: { tcp: {
      description: "TCP", scheme: "tcp" as const, domain: "127.0.0.1", listenHost: "127.0.0.1", listenPort
    } } };
    const workspace = { id: "project:work", name: "work", projectId: "project", projectName: "project" };
    const first = await registerPlugins([createExternalUrlsPlugin(options)]);
    const controller = createDimController({
      stateRoot,
      routes: first.controllerRoutes,
      authenticate: async () => workspace,
      resolveTarget: async (_workspace, target) => ({
        protocol: target.protocol,
        host: "127.0.0.1",
        port: target.port,
        fingerprint: `target:${target.port}`
      })
    });
    await listen(controller);
    const base = `http://127.0.0.1:${address(controller).port}`;
    expect((await fetch(`${base}/api/urls`, {
      method: "POST",
      headers: { authorization: "Bearer valid", "content-type": "application/json" },
      body: JSON.stringify({ ingress: "tcp", target: { containers: [], port: 2222, protocol: "tcp" } })
    })).status).toBe(201);
    await close(controller);
    await first.dispose();

    // When: a new instance initializes from the same state.
    const restarted = await registerPlugins([createExternalUrlsPlugin(options)]);
    cleanup.push(() => restarted.dispose());
    const initialize = restarted.controllerRoutes.find((candidate) => candidate.initialize !== undefined)?.initialize;
    if (initialize === undefined) throw new Error("missing route initializer");
    const resolveTarget = vi.fn(async (_target) => ({
      protocol: "tcp" as const,
      host: "127.0.0.1",
      port: 2222,
      fingerprint: "target-generation"
    }));
    const runner = new RecordingRunner();
    await initialize({
      stateRoot,
      runner: { run: runner.run.bind(runner), runStreaming: async () => 0 },
      listWorkspaces: async () => [workspace],
      resolveTarget: async (_workspace, target) => resolveTarget(target)
    });

    // Then: the listener is rebound and the stored target is resolved again.
    expect(resolveTarget).toHaveBeenCalledOnce();
  });
});

describe("Tailscale status", () => {
  it("selects only the running host self CGNAT address", () => {
    expect(tailscaleSelfAddress({
      BackendState: "Running",
      Self: { TailscaleIPs: ["fd7a:115c:a1e0::1", "100.100.10.20"] }
    })).toBe("100.100.10.20");
    expect(() => tailscaleSelfAddress({
      BackendState: "Running",
      Self: { TailscaleIPs: ["127.0.0.1"] }
    })).toThrow(/allowed tailnet IPv4 address/);
    expect(() => tailscaleSelfAddress({ BackendState: "Stopped", Self: { TailscaleIPs: ["100.100.10.20"] } }))
      .toThrow(/not running/);
  });

  it("reads the current host address without changing Tailscale state", async () => {
    // Given: a host Tailscale CLI that exposes only status and records every invocation.
    const root = await mkdtemp(path.join(tmpdir(), "dim-tailscale-status-"));
    const command = path.join(root, "tailscale");
    const calls = path.join(root, "calls");
    await writeFile(command, `#!/bin/sh
printf '%s\\n' "$*" >>${JSON.stringify(calls)}
test "$1 $2" = 'status --json'
printf '%s\\n' '{"BackendState":"Running","Self":{"TailscaleIPs":["100.100.10.20"]}}'
`);
    await chmod(command, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${root}:${originalPath ?? ""}`;
    try {
      // When: the opt-in driver resolves its persisted high port.
      const runtime = await tailscaleIngressDriver.runtime('{"listenPort":49152}');

      // Then: it binds and advertises only the current self address and invokes no mutating command.
      expect(runtime).toEqual({
        scheme: "tcp",
        publicHost: "100.100.10.20",
        listenHost: "100.100.10.20",
        listenPort: 49152,
        upstreamMode: "container-ip"
      });
      expect(await readFile(calls, "utf8")).toBe("status --json\n");
    } finally {
      process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await listen(server);
  const port = address(server).port;
  await close(server);
  return port;
}

function listen(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function address(server: net.Server): net.AddressInfo {
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("missing TCP address");
  return value;
}

function exchange(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setTimeout(1_000, () => socket.destroy(new Error("TCP exchange timed out")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(message));
    socket.once("data", (chunk) => {
      resolve(chunk.toString("utf8"));
      socket.destroy();
    });
    socket.once("close", () => reject(new Error("TCP ingress closed without data")));
  });
}
