import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceStore } from "@slop-lab/dim-core/workspace";
import { ControllerWorkspaces, requireControllerWorkspace, createDimController, ProcessRunner, registerPlugins, type WorkspaceTarget } from "@slop-lab/dim-managed";
import { workspaceRecord } from "../../../support/workspaceFixture.js";
import { createExternalUrlsPlugin } from "../../../../packages/host/plugins/external-urls/src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });

it.each(["stopped", "missing"] as const)("restores saved HTTP/TCP routes when a %s workspace returns after controller startup", async (unavailable) => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-route-restoration-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  vi.stubEnv("DIM_STATE_ROOT", root);
  const record = workspaceRecord("development"), store = new WorkspaceStore(root); await store.write(record);
  const authority = new ControllerWorkspaces({ stateRoot: root }, undefined, root);
  const httpTarget = http.createServer((_request, response) => response.end("restored")); await listen(httpTarget); cleanups.push(() => close(httpTarget));
  const tcpTarget = net.createServer((socket) => socket.pipe(socket)); await listen(tcpTarget); cleanups.push(() => close(tcpTarget));
  const httpPort = await freePort(), tcpPort = await freePort();
  const options = { ingresses: {
    web: { description: "Saved HTTP route", scheme: "http" as const, domain: "example.test", listenHost: "127.0.0.1", listenPort: httpPort },
    raw: { description: "Saved TCP route", scheme: "tcp" as const, domain: "127.0.0.1", listenHost: "127.0.0.1", listenPort: tcpPort }
  } };
  let runtimePresent = true;
  const resolveTarget = async (workspace: { id: string; name: string }, target: WorkspaceTarget) => {
    await requireControllerWorkspace(workspace, root);
    if (!runtimePresent || (await store.read(workspace.name)).phase !== "running") throw new Error("workspace runtime unavailable");
    return { protocol: target.protocol, host: "127.0.0.1", port: target.protocol === "tcp" ? port(tcpTarget) : port(httpTarget), fingerprint: "owned-test-runtime" };
  };
  const first = await registerPlugins([createExternalUrlsPlugin(options)]); cleanups.push(() => first.dispose());
  const api = createDimController({ stateRoot: root, routes: first.controllerRoutes, authenticate: async () => record,
    runWorkspaceRequest: (workspace, operation) => authority.run(workspace, operation), resolveTarget });
  await listen(api); cleanups.push(() => close(api));
  for (const [ingress, protocol] of [["web", "http"], ["raw", "tcp"]] as const) {
    const response = await fetch(`http://127.0.0.1:${port(api)}/api/urls`, { method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ ingress,
        ...(protocol === "http" ? { subdomain: "development--app" } : {}), target: { containers: [], port: 3000, protocol } }) });
    expect(response.status).toBe(201);
  }
  await close(api); await first.dispose();
  runtimePresent = false; await store.write({ ...record, phase: unavailable === "stopped" ? "stopped" : "running" });
  const restarted = await registerPlugins([createExternalUrlsPlugin(options)]); cleanups.push(() => restarted.dispose());
  const initialize = restarted.controllerRoutes.find((route) => route.initialize)?.initialize;
  if (!initialize) throw new Error("missing initializer");
  await initialize({ stateRoot: root, runner: new ProcessRunner(), listWorkspaces: () => authority.list(),
    runWorkspaceRequest: (workspace, operation) => authority.run(workspace, operation), resolveTarget });
  expect(await request(httpPort)).toEqual({ status: 404, body: '{"error":"external route not found"}\n' });
  await expect(exchange(tcpPort)).rejects.toThrow();
  runtimePresent = true; await store.write(record);
  expect(await request(httpPort)).toEqual({ status: 200, body: "restored" });
  expect(await exchange(tcpPort)).toBe("restored TCP");
  await store.remove(record.name); await store.write({ ...record, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
  expect((await request(httpPort)).status).toBe(404);
  await expect(exchange(tcpPort)).rejects.toThrow();
});

function port(server: net.Server): number { const address = server.address(); if (!address || typeof address === "string") throw new Error("missing listener"); return address.port; }
async function listen(server: net.Server): Promise<void> { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
async function close(server: net.Server): Promise<void> { if (!server.listening) return; if (server instanceof http.Server) server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
async function freePort(): Promise<number> { const server = net.createServer(); await listen(server); const selected = port(server); await close(server); return selected; }
function request(selected: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: selected, headers: { host: "development--app.example.test" } }, (response) => {
      const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    }); request.once("error", reject);
  });
}
function exchange(selected: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: selected, allowHalfOpen: true }), chunks: Buffer[] = [];
    socket.setTimeout(2000, () => socket.destroy(new Error("TCP restoration timed out")));
    socket.on("data", (chunk) => chunks.push(chunk)); socket.once("error", reject);
    socket.once("end", () => { socket.destroy(); const bytes = Buffer.concat(chunks).toString(); if (bytes) resolve(bytes); else reject(new Error("route unavailable")); });
    socket.end("restored TCP");
  });
}
