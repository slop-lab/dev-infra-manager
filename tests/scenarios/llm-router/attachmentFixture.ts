import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { WorkspaceStore, WorkspaceService, ContainerWorkspaceRuntime, ProcessRunner, workspaceServiceEndpoint } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { createRouter } from "../../../packages/control-plane/plugins/llm-router/src/server.js";
import { parseConfig, backendProfile, defaultLimits } from "../../../packages/control-plane/plugins/llm-router/src/config.js";
import { createHostGateway } from "../../../packages/host/plugins/llm-router/src/gateway.js";
import { loadHostConfig } from "../../../packages/host/plugins/llm-router/src/config.js";
import { workspaceRecord } from "../../support/workspaceFixture.js";
import { openWorkspaceServiceChannel } from "../../../packages/host/core/src/workspace/serviceChannel.js";

export const { runLlmCommand } = await import(new URL("cli.js", process.env.DIM_TEST_ROUTER_DIST ?? new URL("../../../packages/host/plugins/llm-router/dist/", import.meta.url)).href) as typeof import("../../../packages/host/plugins/llm-router/src/cli.js");
export const { hostPlugin } = await import(new URL("index.js", process.env.DIM_TEST_ROUTER_DIST ?? new URL("../../../packages/host/plugins/llm-router/dist/", import.meta.url)).href) as typeof import("../../../packages/host/plugins/llm-router/src/index.js");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no listener");
  return `http://127.0.0.1:${address.port}`;
}
export async function fixture(stream = false) {
  const root = await mkdtemp(join(tmpdir(), "dim-llm-separated-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  let upstreamClosed = false, seenAuthorization: string | undefined;
  const backend = createServer((request, response) => {
    seenAuthorization = request.headers.authorization;
    response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
    if (stream) { response.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'); response.once("close", () => { upstreamClosed = true; }); }
    else response.end('{"status":"completed","model":"reviewed-model","usage":{"input_tokens":2,"output_tokens":1}}');
  });
  const backendOrigin = await listen(backend); cleanup.push(async () => { backend.closeAllConnections(); await new Promise<void>((resolve) => backend.close(() => resolve())); });
  const backendKey = "private-backend-key", issuerKey = randomBytes(32).toString("base64url");
  await writeFile(join(root, "backend.key"), backendKey, { mode: 0o600 }); await writeFile(join(root, "issuer.key"), issuerKey, { mode: 0o600 });
  await writeFile(join(root, "issuer-b.key"), randomBytes(32).toString("base64url"), { mode: 0o600 });
  const cpConfig = parseConfig({ schemaVersion: 3, stateDirectory: join(root, "cp"),
    hostIssuers: [{ id: "host-a", keyFile: join(root, "issuer.key"), projects: [{ id: "application", routeIds: ["default", "secondary"] }] },
      { id: "host-b", keyFile: join(root, "issuer-b.key"), projects: [{ id: "application", routeIds: ["default", "secondary"] }] }],
    listen: { host: "127.0.0.1", port: 8318 }, backend: backendProfile,
    accounts: [{ id: "default", reference: "exclusive-account", endpoint: backendOrigin, keyFile: join(root, "backend.key") }],
    routes: ["default", "secondary"].map((id) => ({ id, accountId: "default", models: [{ id: "reviewed-model", name: "Reviewed", api: "responses", context: 10000, output: 1000 }] })), limits: defaultLimits });
  const cp = await createRouter(cpConfig);
  const cpOrigin = await listen(cp.server); cleanup.push(() => cp.close());
  cp.ledger.createProject("application", { allowedRoutes: ["default", "secondary"], limits: defaultLimits, captureMode: "required", tokenMode: "observe" });
  const store = new WorkspaceStore(join(root, "host-workspaces")), workspace = workspaceRecord(); await store.write(workspace);
  const runner = new ProcessRunner(), service = new WorkspaceService(store, new ContainerWorkspaceRuntime(runner), async () => { throw new Error("unexpected acquisition"); });
  const context: WorkspaceHostPluginContext = { runner, cleanupRunner: runner, stateRoot: store.root, store, service, signal: new AbortController().signal };
  vi.spyOn(console, "log").mockImplementation(() => {});
  const directory = join(root, "host");
  await runLlmCommand(["llm", "prepare", directory, "--control-plane", cpOrigin, "--issuer", "host-a", "--issuer-key-file", join(root, "issuer.key"), "--endpoint", "http://127.0.0.1:8319"], context);
  const configPath = join(directory, "gateway.json"), config = await loadHostConfig(configPath);
  const gateway = await createHostGateway(config, store), gatewayOrigin = await listen(gateway.server); cleanup.push(() => gateway.close());
  config.publicEndpoint = gatewayOrigin; config.listen.port = Number(new URL(gatewayOrigin).port); await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const home = join(root, "guest-home"); await mkdir(home, { mode: 0o700 });
  const channel = openWorkspaceServiceChannel({ token: randomBytes(32).toString("base64url"), port: 19420, signal: context.signal,
    current: async () => { const current = await store.read(workspace.name); return current.id === workspace.id && current.phase === "running"; },
    resolve: async (name) => name === "llm-router" ? gatewayOrigin : undefined,
    exec: (command, options) => runner.runStreaming(command[0] ?? "node", command.slice(1), options),
  });
  cleanup.push(() => channel.close()); await channel.ready;
  const guestEnvironment = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  vi.spyOn(service, "exec").mockImplementation(async (name, args, options) => {
    expect(name).toBe(workspace.name); expect(options?.workspaceId).toBe(workspace.id);
    const chunks: Buffer[] = []; if (options?.stdin) for await (const chunk of options.stdin) chunks.push(Buffer.from(chunk));
    return new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, args.slice(1), { env: guestEnvironment, stdio: ["pipe", "pipe", "pipe"] });
      if (options?.stdout) child.stdout.pipe(options.stdout, { end: false }); else child.stdout.resume();
      child.stderr.resume(); child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); child.stdin.end(Buffer.concat(chunks));
    });
  });
  await runLlmCommand(["llm", "attach", workspace.name, "--config", configPath, "--project", "application"], context);
  const connectionPath = join(home, ".config/dim/llm-router.json");
  const connection: unknown = JSON.parse(await readFile(connectionPath, "utf8"));
  if (typeof connection !== "object" || connection === null || !("token" in connection) || typeof connection.token !== "string") throw new Error("missing guest token");
  const token = connection.token;
  const request = () => fetch(workspaceServiceEndpoint("llm-router") + "/v1/responses", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "reviewed-model", input: "hello", stream }) });
  return { root, home, guestEnvironment, store, workspace, context, config, cpConfig, cp, cpOrigin, gatewayOrigin, connectionPath, connection, token, request,
    backendKey, issuerKey, upstreamClosed: () => upstreamClosed, seenAuthorization: () => seenAuthorization };
}
