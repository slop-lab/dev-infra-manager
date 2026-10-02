import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  configuredDimAgentController,
  configuredDimController
} from "../../../../core/packages/core/src/controller.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { DIM_PLUGIN_API_VERSION, registerPlugin } from "../../../../core/packages/core/src/plugin.js";
import { hostLifecycleOptions, hostRecord, workspaceRecord } from "./hostLifecycleFixture.js";

describe("controller proxy audience integration", () => {
  const servers: Server[] = [];
  const proxies: ChildProcess[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) {
      proxy.kill("SIGTERM");
      if (proxy.exitCode === null) await once(proxy, "exit");
    }
    await Promise.all(servers.splice(0).map(closeServer));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("keeps restart and resources on their audience-specific upstreams", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-controller-proxy-audiences-"));
    roots.push(root);
    const state = new LifecycleState(root);
    const workspaceA = { ...workspaceRecord("a", "ready"), cpuCount: "2.5", memory: "5g", pidsLimit: "500" };
    const workspaceB = {
      ...workspaceRecord("b", "ready"),
      workspaceId: "B".repeat(43),
      cpuCount: "6",
      memory: "9g",
      pidsLimit: "900"
    };
    await state.claimWorkspace(workspaceA);
    await state.claimWorkspace(workspaceB);
    await state.writeHostLifecycle(hostRecord("ready"));
    const workspaceGrantA = await state.ensureWorkspaceGrant("a");
    const agentGrantA = await state.ensureAgentGrant("a");
    const plugins = await registerPlugin({
      name: "proxy-audience-test",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register() {}
    });
    const workspaceSocket = join(root, "workspace-controller.sock");
    const agentSocket = join(root, "agent-controller.sock");
    const workspaceServer = configuredDimController(hostLifecycleOptions(root), plugins);
    const agentServer = configuredDimAgentController(hostLifecycleOptions(root), plugins);
    servers.push(workspaceServer, agentServer);
    workspaceServer.listen(workspaceSocket);
    agentServer.listen(agentSocket);
    await Promise.all([once(workspaceServer, "listening"), once(agentServer, "listening")]);
    const environment = {
      ...process.env,
      DIM_CONTROLLER_SOCKET: workspaceSocket,
      DIM_CONTROLLER_TOKEN: workspaceGrantA,
      DIM_AGENT_CONTROLLER_SOCKET: agentSocket,
      DIM_AGENT_CONTROLLER_TOKEN: agentGrantA
    };
    const restartSocket = join(root, "restart-proxy.sock");
    const resourcesSocket = join(root, "resources-proxy.sock");
    proxies.push(await startProxy(restartSocket, "--allow-workspace-restart", environment));
    proxies.push(await startProxy(resourcesSocket, "--allow-workspace-resources", environment));

    // When
    const resources = await request(resourcesSocket, "GET", "/api/workspace/resources");
    const restartDiscovery = await request(restartSocket, "GET", "/api");

    // Then
    expect(resources).toEqual({
      status: 200,
      body: '{"cpuCount":"2.5","memory":"5g","pidsLimit":"500"}\n'
    });
    expect(JSON.parse(restartDiscovery.body)).toMatchObject({
      routes: [{ method: "POST", path: "/api/workspace/restart" }],
      hostInputProviders: []
    });
    expect((await request(resourcesSocket, "GET", "/api/workspace/resources/b")).status).toBe(403);
    expect((await request(resourcesSocket, "POST", "/api/workspace/restart")).status).toBe(403);
    expect((await request(resourcesSocket, "GET", "/api/admin")).status).toBe(403);
    expect((await request(restartSocket, "POST", "/api/host-inputs/builtin.git-author")).status).toBe(403);
    await plugins.dispose();
  });

  it("rejects a proxy that combines workspace and agent audience routes", async () => {
    // Given
    const executable = resolve(import.meta.dirname, "../../../node_modules/.bin/tsx");
    const cli = resolve(import.meta.dirname, "../../../../core/packages/controller-proxy/src/cli.ts");
    const child = spawn(executable, [
      cli,
      "agent",
      "--listen",
      join(tmpdir(), "combined-controller-proxy.sock"),
      "--allow-workspace-restart",
      "--allow-workspace-resources"
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });

    // When
    const [code] = await once(child, "exit");

    // Then
    expect(code).toBe(1);
    expect(stderr).toContain("dim-controller-proxy agent --listen SOCKET --allow-workspace-restart");
    expect(stderr).toContain("dim-controller-proxy agent --listen SOCKET --allow-workspace-resources");
  });
});

async function startProxy(
  socketPath: string,
  capability: "--allow-workspace-restart" | "--allow-workspace-resources",
  environment: NodeJS.ProcessEnv
): Promise<ChildProcess> {
  const executable = resolve(import.meta.dirname, "../../../node_modules/.bin/tsx");
  const cli = resolve(import.meta.dirname, "../../../../core/packages/controller-proxy/src/cli.ts");
  const child = spawn(executable, [cli, "agent", "--listen", socketPath, capability], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveStart, rejectStart) => {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (chunk.includes("DIM controller proxy listening")) resolveStart();
    });
    child.once("exit", (code) => rejectStart(new Error(`proxy exited with ${code}: ${stderr}`)));
    child.once("error", rejectStart);
  });
  return child;
}

function request(socketPath: string, method: string, requestPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = http.request({ socketPath, method, path: requestPath }, async (response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      resolveRequest({
        status: response.statusCode ?? 500,
        body: Buffer.concat(chunks).toString("utf8")
      });
    });
    outgoing.once("error", rejectRequest);
    outgoing.end();
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) =>
    server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
}
