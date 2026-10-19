// @ts-check
import assert from "node:assert/strict";
import http from "node:http";
import { createConnection, createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
/** @type {typeof import("../../packages/host/core/src/workspace.js")} */
const { WorkspaceStore, WorkspaceService, ContainerWorkspaceRuntime, ProcessRunner, workspaceRuntimeResources } = await import(new URL("../../packages/host/core/dist/workspace.js", import.meta.url).href);
/** @type {typeof import("../../core/packages/managed/src/controllerWorkspace.js")} */
const { ControllerWorkspaces } = await import(new URL("../../core/packages/managed/dist/controllerWorkspace.js", import.meta.url).href);
/** @type {typeof import("../../core/packages/managed/src/index.js")} */
const { registerPlugins, createDimController } = await import(new URL("../../core/packages/managed/dist/index.js", import.meta.url).href);
/** @type {typeof import("../../packages/host/plugins/external-urls/src/index.js")} */
const { createExternalUrlsPlugin } = await import(new URL("../../packages/host/plugins/external-urls/dist/index.js", import.meta.url).href);

const image = process.argv[2];
if (!image) throw new Error("usage: node verification/scripts/controller-workspace-relay-smoke.mjs WORKSPACE_IMAGE");
const root = await mkdtemp(join(tmpdir(), "dim-controller-relay-smoke-"));
const runner = new ProcessRunner(), runtime = new ContainerWorkspaceRuntime(runner);
const store = new WorkspaceStore(join(root, "core"));
const service = new WorkspaceService(store, runtime, async ({ destination }) => {
  await mkdir(destination); await writeFile(join(destination, "README.md"), "disposable relay smoke\n");
  const initialized = await runner.run("git", ["init", destination]); assert.equal(initialized.exitCode, 0, initialized.stderr);
  return { url: "https://example.invalid/relay-smoke.git", ref: "refs/heads/main", commit: "a".repeat(40) };
});
const controller = new ControllerWorkspaces({ stateRoot: join(root, "managed") }, runner, store.root);
/** @type {import("../../packages/host/core/src/workspace.js").WorkspaceRecord | undefined} */
let record;
/** @type {Awaited<ReturnType<typeof registerPlugins>> | undefined} */
let plugin;
/** @type {ReturnType<typeof createDimController> | undefined} */
let api;
/** @type {{id: string, marker: string} | undefined} */
let foreign;
const previousCoreRoot = process.env.DIM_STATE_ROOT;
process.env.DIM_STATE_ROOT = store.root;
try {
  record = await service.create({ name: "relay-smoke", source: { url: "https://example.invalid/relay-smoke.git" }, image });
  const agent = await runtime.inspect(record); assert.ok(agent?.running);
  await startTarget(agent.id, "initial");
  /** @type {import("../../core/packages/managed/src/controller.js").WorkspaceTarget} */
  const target = { containers: [], port: 3456, protocol: "tcp" };
  const selected = { id: record.id, name: record.name };
  const first = await controller.resolveTarget(selected, target);
  assert.deepEqual(await controller.resolveTarget(selected, target), first);
  const bytes = Buffer.alloc(1024 * 1024 + 1); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  assert.deepEqual(await Promise.all([exchange(first, bytes), exchange(first, Buffer.from("concurrent request"))]), [bytes, Buffer.from("concurrent request")]);
  const token = await controller.ensureGrant(record.name);
  const ingressPort = await availablePort(), tcpIngressPort = await availablePort();
  /** @type {Parameters<typeof createExternalUrlsPlugin>[0]} */
  const pluginOptions = { ingresses: { smoke: {
    description: "Disposable ownership smoke", scheme: "http", domain: "smoke.test", listenHost: "127.0.0.1", listenPort: ingressPort
  }, raw: { description: "Disposable half-close smoke", scheme: "tcp", domain: "127.0.0.1", listenHost: "127.0.0.1", listenPort: tcpIngressPort } } };
  plugin = await registerPlugins([createExternalUrlsPlugin(pluginOptions)]);
  api = createDimController({ stateRoot: join(root, "managed"), routes: plugin.controllerRoutes,
    authenticate: (grant) => controller.authenticate(grant), runWorkspaceRequest: (workspace, operation) => controller.run(workspace, operation),
    resolveTarget: (workspace, requested) => controller.resolveTarget(workspace, requested) });
  await listen(api);
  const apiPort = portOf(api);
  const route = await fetch(`http://127.0.0.1:${apiPort}/api/urls`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ingress: "smoke", subdomain: "relay-smoke--app", target: { containers: [], port: 3457, protocol: "http" } }) });
  assert.equal(route.status, 201, await route.clone().text());
  const tcpRoute = await fetch(`http://127.0.0.1:${apiPort}/api/urls`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ingress: "raw", target }) });
  assert.equal(tcpRoute.status, 201, await tcpRoute.clone().text());
  assert.deepEqual(await exchange({ host: "127.0.0.1", port: tcpIngressPort }, bytes), bytes);
  /** @returns {Promise<{status: number, text: () => Promise<string>}>} */
  const gateway = () => new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: ingressPort, headers: { host: "relay-smoke--app.smoke.test" } }, (response) => {
      /** @type {Buffer[]} */
      const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode ?? 0, text: async () => Buffer.concat(chunks).toString() }));
    }); request.once("error", reject);
  });
  assert.equal(await (await gateway()).text(), "initial");
  /** @type {import("../../core/packages/managed/src/controller.js").WorkspaceTarget} */
  const httpTarget = { containers: [], port: 3457, protocol: "http" };
  const initialHttp = await controller.resolveTarget(selected, httpTarget);
  record = await service.stop(record.name);
  await closeApi(api); api = undefined;
  await plugin.dispose();
  plugin = await registerPlugins([createExternalUrlsPlugin(pluginOptions)]);
  const initialize = plugin.controllerRoutes.find((route) => route.initialize)?.initialize;
  assert.ok(initialize);
  await initialize({ stateRoot: join(root, "managed"), runner, listWorkspaces: () => controller.list(),
    runWorkspaceRequest: (workspace, operation) => controller.run(workspace, operation),
    resolveTarget: (workspace, requested) => controller.resolveTarget(workspace, requested) });
  assert.equal((await gateway()).status, 404);
  record = await service.start(record.name);
  const restarted = await runtime.inspect(record); assert.ok(restarted?.running);
  await startTarget(restarted.id, "restarted");
  const restored = await gateway(); assert.equal(restored.status, 200); assert.equal(await restored.text(), "restarted");
  assert.deepEqual(await exchange({ host: "127.0.0.1", port: tcpIngressPort }, bytes), bytes);
  console.log("PASS controller restart while workspace stopped restores HTTP/TCP lazily after start");
  record = await service.recreate(record.name);
  assert.equal(record.id, selected.id);
  const recreated = await runtime.inspect(record); assert.ok(recreated?.running); assert.notEqual(recreated.id, agent.id);
  await startTarget(recreated.id, "recreated");
  const freshResponse = await gateway(); assert.equal(freshResponse.status, 200); assert.equal(await freshResponse.text(), "recreated");
  const refreshedHttp = await controller.resolveTarget(selected, httpTarget);
  assert.notEqual(refreshedHttp.fingerprint, initialHttp.fingerprint);
  assert.deepEqual(await exchange({ host: "127.0.0.1", port: tcpIngressPort }, bytes), bytes);
  console.log("PASS raw TCP gateway preserves binary half-close responses before and after recreation");
  // Leave the core record unchanged, then put an unrelated runtime at its cached relay endpoint.
  assert.equal((await runner.run("docker", ["rm", "--force", recreated.id])).exitCode, 0);
  const marker = randomUUID(), foreignName = `dim-relay-foreign-${marker}`;
  foreign = { id: foreignName, marker };
  const launched = await runner.run("docker", ["run", "--detach", "--name", foreignName, "--label", `dim.relay-smoke=${marker}`,
    "--network", workspaceNetwork(record), "--ip", refreshedHttp.host, "--entrypoint", "node", image, "--input-type=commonjs", "-e",
    `require("node:http").createServer((req,res)=>res.end("foreign")).listen(${refreshedHttp.port},"0.0.0.0")`]);
  assert.equal(launched.exitCode, 0, launched.stderr); foreign = { id: launched.stdout.trim(), marker };
  let reachable = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    reachable = await fetch(`http://${refreshedHttp.host}:${refreshedHttp.port}/`).then(async (response) => await response.text() === "foreign", () => false);
    if (reachable) break; await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(reachable, true);
  assert.equal((await store.read(record.name)).id, selected.id);
  assert.equal((await gateway()).status, 404);
  await removeForeign();
  console.log("PASS gateway recovers same-UUID recreate and denies a foreign runtime reusing its cached IP+port");
  assert.deepEqual(await controller.authenticate(token), selected);
  await store.write({ ...record, id: randomUUID() });
  assert.equal(await controller.authenticate(token), undefined);
  await assert.rejects(controller.resolveTarget(selected, target), /identity/);
  await store.write(record);
  await service.discard(record.name); record = undefined;
  assert.equal(await controller.authenticate(token), undefined);
  console.log("PASS owned Sysbox loopback relay, reuse, concurrent binary half-close, UUID fencing and discard");
} finally {
  await removeForeign();
  if (api) await closeApi(api);
  await plugin?.dispose();
  if (previousCoreRoot === undefined) delete process.env.DIM_STATE_ROOT; else process.env.DIM_STATE_ROOT = previousCoreRoot;
  if (!record) { try { record = await store.read("relay-smoke"); } catch (error) { if (!(error instanceof Error) || error.name !== "MissingRecordError") throw error; } }
  if (record) { await store.write(record); await service.discard(record.name); }
  await rm(root, { recursive: true, force: true });
}

/** @param {{host: string, port: number}} target @param {Buffer} input @returns {Promise<Buffer>} */
function exchange(target, input) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: target.host, port: target.port, allowHalfOpen: true });
    /** @type {Buffer[]} */
    const chunks = [];
    socket.setTimeout(10000, () => socket.destroy(new Error("relay exchange timed out")));
    socket.on("data", (chunk) => chunks.push(chunk)); socket.once("error", reject);
    socket.once("end", () => { socket.destroy(); resolve(Buffer.concat(chunks)); });
    socket.end(input);
  });
}

/** @param {import("../../packages/host/core/src/workspace.js").WorkspaceRecord} workspace */
function workspaceNetwork(workspace) { return workspaceRuntimeResources(workspace).network; }
async function availablePort() {
  const listener = createServer(); await listen(listener);
  const port = portOf(listener); await new Promise((resolve) => listener.close(() => resolve(undefined))); return port;
}
/** @param {string} container @param {string} label */
async function startTarget(container, label) {
  const started = await runner.run("docker", ["exec", "--detach", "--user", "dim", container, "node", "--input-type=commonjs", "-e", `
    require("node:net").createServer({ allowHalfOpen: true }, (socket) => {
      /** @type {Buffer[]} */
      const chunks = []; socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => socket.end(Buffer.concat(chunks)));
    }).listen(3456, "127.0.0.1");
    require("node:http").createServer((req,res)=>res.end(${JSON.stringify(label)})).listen(3457,"127.0.0.1");
  `]);
  assert.equal(started.exitCode, 0, started.stderr);
}
async function removeForeign() {
  if (!foreign) return;
  const inspected = await runner.run("docker", ["inspect", foreign.id, "--format", '{{index .Config.Labels "dim.relay-smoke"}}']);
  if (inspected.exitCode !== 0 && /No such (?:object|container)/i.test(inspected.stderr)) { foreign = undefined; return; }
  assert.equal(inspected.exitCode, 0, inspected.stderr); assert.equal(inspected.stdout.trim(), foreign.marker);
  const removed = await runner.run("docker", ["rm", "--force", foreign.id]); assert.equal(removed.exitCode, 0, removed.stderr); foreign = undefined;
}

/** @param {import("node:net").Server} server */
function portOf(server) { const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port; }
/** @param {import("node:net").Server} server */
function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined))); }
/** @param {import("node:http").Server} server */
function closeApi(server) { return new Promise((resolve) => { server.close(() => resolve(undefined)); server.closeAllConnections(); }); }
