import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceStore, WorkspaceService, ContainerWorkspaceRuntime, ProcessRunner } from "../../core/packages/core/dist/workspace.js";
import { ControllerWorkspaces } from "../../core/packages/managed/dist/controllerWorkspace.js";

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
let record;
try {
  record = await service.create({ name: "relay-smoke", source: { url: "https://example.invalid/relay-smoke.git" }, image });
  const agent = await runtime.inspect(record); assert.ok(agent?.running);
  const started = await runner.run("docker", ["exec", "--detach", "--user", "dim", agent.id, "node", "--input-type=commonjs", "-e", `
    const net = require("node:net");
    net.createServer({ allowHalfOpen: true }, (socket) => {
      const chunks = []; socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => socket.end(Buffer.concat(chunks)));
    }).listen(3456, "127.0.0.1");
  `]);
  assert.equal(started.exitCode, 0, started.stderr);
  const target = { containers: [], port: 3456, protocol: "tcp" };
  const selected = { id: record.id, name: record.name };
  const first = await controller.resolveTarget(selected, target, "container-ip");
  assert.deepEqual(await controller.resolveTarget(selected, target, "container-dns"), first);
  const bytes = Buffer.alloc(1024 * 1024 + 1); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  assert.deepEqual(await Promise.all([exchange(first, bytes), exchange(first, Buffer.from("concurrent request"))]), [bytes, Buffer.from("concurrent request")]);
  const token = await controller.ensureGrant(record.name);
  assert.deepEqual(await controller.authenticate(token), selected);
  await store.write({ ...record, id: randomUUID() });
  assert.equal(await controller.authenticate(token), undefined);
  await assert.rejects(controller.resolveTarget(selected, target, "container-ip"), /identity/);
  await store.write(record);
  await service.discard(record.name); record = undefined;
  assert.equal(await controller.authenticate(token), undefined);
  console.log("PASS owned Sysbox loopback relay, reuse, concurrent binary half-close, UUID fencing and discard");
} finally {
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
