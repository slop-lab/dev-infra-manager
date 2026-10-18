import assert from "node:assert/strict";
import http from "node:http";
import { createConnection, createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceStore, WorkspaceService, ContainerWorkspaceRuntime, ProcessRunner, workspaceRuntimeResources } from "../../core/packages/core/dist/workspace.js";
import { ControllerWorkspaces } from "../../core/packages/managed/dist/controllerWorkspace.js";
import { registerPlugins, createDimController } from "../../core/packages/managed/dist/index.js";
import { createExternalUrlsPlugin } from "../../plugin-external-urls/dist/index.js";

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
let record, plugin, api, foreign;
const previousCoreRoot = process.env.DIM_STATE_ROOT;
process.env.DIM_STATE_ROOT = store.root;
try {
  record = await service.create({ name: "relay-smoke", source: { url: "https://example.invalid/relay-smoke.git" }, image });
  const agent = await runtime.inspect(record); assert.ok(agent?.running);
  await startTarget(agent.id, "initial");
  const target = { containers: [], port: 3456, protocol: "tcp" };
  const selected = { id: record.id, name: record.name };
  const first = await controller.resolveTarget(selected, target);
  assert.deepEqual(await controller.resolveTarget(selected, target), first);
  const bytes = Buffer.alloc(1024 * 1024 + 1); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  assert.deepEqual(await Promise.all([exchange(first, bytes), exchange(first, Buffer.from("concurrent request"))]), [bytes, Buffer.from("concurrent request")]);
  const token = await controller.ensureGrant(record.name);
  const ingressPort = await availablePort();
  plugin = await registerPlugins([createExternalUrlsPlugin({ ingresses: { smoke: {
    description: "Disposable ownership smoke", scheme: "http", domain: "smoke.test", listenHost: "127.0.0.1", listenPort: ingressPort
  } } })]);
  api = createDimController({ stateRoot: join(root, "managed"), routes: plugin.controllerRoutes,
    authenticate: (grant) => controller.authenticate(grant), runWorkspaceRequest: (workspace, operation) => controller.run(workspace, operation),
    resolveTarget: (workspace, requested) => controller.resolveTarget(workspace, requested) });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const apiPort = api.address().port;
  const route = await fetch(`http://127.0.0.1:${apiPort}/api/urls`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ingress: "smoke", subdomain: "relay-smoke--app", target: { containers: [], port: 3457, protocol: "http" } }) });
  assert.equal(route.status, 201, await route.clone().text());
  const gateway = () => new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: ingressPort, headers: { host: "relay-smoke--app.smoke.test" } }, (response) => {
      const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode, text: async () => Buffer.concat(chunks).toString() }));
    }); request.once("error", reject);
  });
  assert.equal(await (await gateway()).text(), "initial");
  const httpTarget = { containers: [], port: 3457, protocol: "http" };
  const initialHttp = await controller.resolveTarget(selected, httpTarget);
  record = await service.recreate(record.name);
  assert.equal(record.id, selected.id);
  const recreated = await runtime.inspect(record); assert.ok(recreated?.running); assert.notEqual(recreated.id, agent.id);
  await startTarget(recreated.id, "recreated");
  const freshResponse = await gateway(); assert.equal(freshResponse.status, 200); assert.equal(await freshResponse.text(), "recreated");
  const refreshedHttp = await controller.resolveTarget(selected, httpTarget);
  assert.notEqual(refreshedHttp.fingerprint, initialHttp.fingerprint);
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
  if (api) await new Promise((resolve) => { api.close(resolve); api.closeAllConnections(); });
  await plugin?.dispose();
  if (previousCoreRoot === undefined) delete process.env.DIM_STATE_ROOT; else process.env.DIM_STATE_ROOT = previousCoreRoot;
  if (!record) { try { record = await store.read("relay-smoke"); } catch (error) { if (!(error instanceof Error) || error.name !== "MissingRecordError") throw error; } }
  if (record) { await store.write(record); await service.discard(record.name); }
  await rm(root, { recursive: true, force: true });
}

function exchange(target, input) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: target.host, port: target.port, allowHalfOpen: true });
    const chunks = [];
    socket.setTimeout(10000, () => socket.destroy(new Error("relay exchange timed out")));
    socket.on("data", (chunk) => chunks.push(chunk)); socket.once("error", reject);
    socket.once("end", () => { socket.destroy(); resolve(Buffer.concat(chunks)); });
    socket.end(input);
  });
}

function workspaceNetwork(workspace) { return workspaceRuntimeResources(workspace).network; }
async function availablePort() {
  const listener = createServer(); await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve)); return port;
}
async function startTarget(container, label) {
  const started = await runner.run("docker", ["exec", "--detach", "--user", "dim", container, "node", "--input-type=commonjs", "-e", `
    require("node:net").createServer({ allowHalfOpen: true }, (socket) => {
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
