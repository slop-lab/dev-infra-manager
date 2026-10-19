import type { WorkspaceRecord } from "../../packages/host/core/src/workspace/models.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "../..");
const load = (file: string): Promise<unknown> => import(pathToFileURL(path.join(repo, file)).href);
const { ProcessRunner, WorkspaceStore, WorkspaceService, ContainerWorkspaceRuntime, workspaceRuntimeResources } = await load("packages/host/core/dist/workspace.js") as typeof import("../../packages/host/core/src/workspace.js");
const { prepareControlPlane, connectControlPlane } = await load("packages/control-plane/admin/dist/controlPlaneSetup.js") as typeof import("../../packages/control-plane/admin/src/controlPlaneSetup.js");
const { configuredNativeGitBundleServer } = await load("packages/control-plane/plugins/native-git/dist/service.js") as typeof import("../../packages/control-plane/plugins/native-git/src/service.js");
const { parseNativeGitBundleConfig } = await load("packages/control-plane/plugins/native-git/dist/bundle-config.js") as typeof import("../../packages/control-plane/plugins/native-git/src/bundle-config.js");
const { dimWorkflowCompiler } = await load("packages/control-plane/plugins/ci-workflows/dist/index.js") as typeof import("../../packages/control-plane/plugins/ci-workflows/src/index.js");
const { bootstrapNativeProjectRepository } = await load("packages/host/plugins/native-git/dist/nativeProjectBootstrap.js") as typeof import("../../packages/host/plugins/native-git/src/nativeProjectBootstrap.js");
const { NativeProjectPendingStore } = await load("packages/host/plugins/native-git/dist/nativeProjectPendingStore.js") as typeof import("../../packages/host/plugins/native-git/src/nativeProjectPendingStore.js");
const { createNodeNativeGitRootImporterClient } = await load("packages/host/plugins/native-git/dist/nativeGitRootImporterClient.js") as typeof import("../../packages/host/plugins/native-git/src/nativeGitRootImporterClient.js");
const { loadNativeControlPlaneConnection } = await load("packages/host/plugins/native-git/dist/nativeControlPlaneConnection.js") as typeof import("../../packages/host/plugins/native-git/src/nativeControlPlaneConnection.js");
const { saveControlPlaneSelection } = await load("packages/host/plugins/native-git/dist/controlPlaneSelection.js") as typeof import("../../packages/host/plugins/native-git/src/controlPlaneSelection.js");
const { createManagedWorkspace, ensureManagedWorkspace } = await load("packages/host/plugins/native-git/dist/nativeWorkspaceHost.js") as typeof import("../../packages/host/plugins/native-git/src/nativeWorkspaceHost.js");
const { readNativeWorkspaceAttachment, nativeWorkspaceAttachmentFile } = await load("packages/host/plugins/native-git/dist/nativeWorkspaceAttachment.js") as typeof import("../../packages/host/plugins/native-git/src/nativeWorkspaceAttachment.js");

const root = await mkdtemp(path.join(os.tmpdir(), "dim-native-workspace-smoke-"));
const name = `native-smoke-${Date.now()}`;
const image = process.argv[2] ?? "dim-workspace-runtime-smoke:base-20261018";
const runner = new ProcessRunner();
const store = new WorkspaceStore(path.join(root, "workspaces"));
const runtime = new ContainerWorkspaceRuntime(runner);
const base = new WorkspaceService(store, runtime, async () => { throw new Error("existing workspace lifecycle must not reacquire source"); });
let service: Awaited<ReturnType<typeof configuredNativeGitBundleServer>> | undefined;
const oldEnvironment = { DIM_MANAGED_STATE_ROOT: process.env.DIM_MANAGED_STATE_ROOT,
  DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: process.env.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE };
try {
  const operator = path.join(root, "operator");
  await prepareControlPlane({ directory: operator, nativeGitImage: `registry.example/native@sha256:${"a".repeat(64)}`,
    ordinaryCiImage: `registry.example/ordinary@sha256:${"b".repeat(64)}` });
  const native = { ...parseNativeGitBundleConfig(JSON.parse(await readFile(path.join(operator, "native-git.json"), "utf8"))),
    gitVersion: execFileSync("/usr/bin/git", ["--version"], { encoding: "utf8" }).trim().replace(/^git version /, "") };
  await writeFile(path.join(operator, "native-git.json"), JSON.stringify(native), { mode: 0o600 });
  const generationId = "c".repeat(64);
  const activationToken = Buffer.alloc(32, 71).toString("base64url");
  service = await configuredNativeGitBundleServer({ workflowCompiler: dimWorkflowCompiler,
    config: parseNativeGitBundleConfig(native), stateDirectory: path.join(root, "native-service"),
    readinessToken: Buffer.alloc(32, 72).toString("base64url"), activationToken, expectedGenerationId: generationId });
  const endpoint = await service.listen("127.0.0.1", 0);
  const connected = await connectControlPlane(operator, { endpoint });
  const activated = await fetch(`${endpoint}/v1/activation`, { method: "POST",
    headers: { authorization: `Bearer ${activationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId }) });
  assert.equal(activated.status, 200);
  const source = path.join(root, "source");
  execFileSync("/usr/bin/git", ["init", "--initial-branch=main", source]);
  await writeFile(path.join(source, "README.md"), "managed native workspace\n");
  execFileSync("/usr/bin/git", ["-C", source, "add", "."]);
  execFileSync("/usr/bin/git", ["-C", source, "-c", "user.name=DIM Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "initial"]);
  const managedRoot = path.join(root, "managed"); await mkdir(managedRoot, { mode: 0o700 });
  const projects = new NativeProjectPendingStore(managedRoot);
  const connection = await loadNativeControlPlaneConnection(path.join(connected.directory, "host.json"));
  await projects.create({ name: "example", projectId: "example", ownerHostId: connection.hostId });
  await bootstrapNativeProjectRepository({ name: "example", projectId: "example", stateRoot: managedRoot, scratchRoot: managedRoot,
    repositoryId: "app", sourceRepository: source, gitExecutable: "/usr/bin/git", selectedRef: "refs/heads/main",
    registrarConnectionFile: path.join(connected.directory, "registrar.json"), importerConnectionFile: path.join(connected.directory, "importer.json"),
    policySource: { kind: "manifest-free", review: { requiredReviewerIds: ["owner"], requiredJobs: [], ciRepositoryIds: ["app"] } },
    signal: AbortSignal.timeout(30_000) });
  await projects.admitRepository("example", "app", await createNodeNativeGitRootImporterClient(path.join(connected.directory, "importer.json")), connection, AbortSignal.timeout(10_000));
  await projects.configure("example", { configurationRepositoryId: "app", defaultWorkingRepositoryId: "app" }, connection, AbortSignal.timeout(10_000));
  process.env.DIM_MANAGED_STATE_ROOT = managedRoot;
  process.env.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE = path.join(connected.directory, "host.json");
  const record: WorkspaceRecord = await createManagedWorkspace({ name, source: { url: "dim://example" }, image,
    resources: { cpuCount: "2", memory: "2g", pidsLimit: "512" } }, { runner, store });
  assert.equal(record.schemaVersion, 10);
  assert.equal(record.source.url, "dim://example");
  assert.equal((await base.list()).length, 1);
  const resources = workspaceRuntimeResources(record);
  const inspection = await runner.run("docker", ["inspect", resources.container]);
  const inspected: unknown = JSON.parse(inspection.stdout); assert(Array.isArray(inspected));
  const actual = object(inspected[0]), hostConfig = object(actual.HostConfig);
  assert.equal(hostConfig.Privileged, false);
  assert.equal(hostConfig.Runtime, "sysbox-runc");
  assert(Array.isArray(actual.Mounts));
  assert.deepEqual(actual.Mounts.map((mount: unknown) => object(mount).Type), ["volume", "volume", "volume"]);
  const attachment = await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(managedRoot, record.id));
  const repository = attachment.repositories.app; assert(repository);
  const auth = { authorization: `Basic ${Buffer.from(`dim:${repository.grant}`).toString("base64")}` };
  const broker = `http://${attachment.gateway}:${attachment.port}`;
  assert.equal((await fetch(`${broker}/api/host-inputs/private`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${broker}/v1/projects/foreign/repositories/app.git/info/refs?service=git-upload-pack`, { headers: auth })).status, 404);
  const git = async (args: string[], success = true) => {
    const result = await runtime.run(record, ["git", ...args]);
    assert.equal(result.exitCode === 0, success, `${args.join(" ")}: ${result.stderr}`);
    return result;
  };
  await git(["fetch", "origin"]);
  const changed = await runtime.run(record, ["sh", "-c", "printf 'proposal\\n' >> README.md && git add README.md && git commit -m proposal"]);
  assert.equal(changed.exitCode, 0, changed.stderr);
  await git(["push", "origin"]);
  await git(["push", "origin", "HEAD:refs/heads/main"], false);
  await git(["push", "origin", `HEAD:refs/heads/proposals/${Buffer.alloc(32, 99).toString("base64url")}/main`], false);
  const protectedHead = execFileSync("/usr/bin/git", ["--git-dir", path.join(root, "native-service/example/app.git"), "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
  assert.equal(protectedHead, record.source.commit);
  const roleHeaders = (credential: { username: string; password: string }) => ({
    authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
    "content-type": "application/json", "x-dim-generation-id": generationId
  });
  const reviewer = native.humanReviewers[0], promoter = native.hostPromoters[0]; assert(reviewer && promoter);
  const resolved = await fetch(`${endpoint}/v1/projects/example/repositories/app/reviews/resolve`, {
    method: "POST", headers: roleHeaders(reviewer),
    body: JSON.stringify({ schemaVersion: 1, proposalRef: `refs/heads/proposals/${repository.nativeWorkspaceId}/main` }) });
  assert.equal(resolved.status, 200, await resolved.clone().text());
  const envelope: unknown = await resolved.json(), review = object(object(envelope).review);
  assert.equal(typeof review.reviewId, "string");
  assert.deepEqual(object(review.inputs).app, { commit: review.candidateCommit, tree: review.candidateTree });
  const reviewPath = `${endpoint}/v1/projects/example/repositories/app/reviews/${String(review.reviewId)}`;
  const approved = await fetch(`${reviewPath}/approvals`, { method: "POST", headers: roleHeaders(reviewer),
    body: JSON.stringify({ requestId: randomUUID() }) });
  assert.equal(approved.status, 201, await approved.clone().text());
  const promoted = await fetch(`${reviewPath}/promotions`, { method: "POST", headers: roleHeaders(promoter),
    body: JSON.stringify({ schemaVersion: 1 }) });
  assert.equal(promoted.status, 201, await promoted.clone().text());
  // Promotion changes the protected head without resetting an existing workspace checkout or its Git capability.
  await git(["fetch", "origin"]);
  const second = await runtime.run(record, ["sh", "-c", "printf 'second proposal\\n' >> README.md && git add README.md && git commit -m second"]);
  assert.equal(second.exitCode, 0, second.stderr);
  await git(["push", "origin"]);
  const beforeReconnect = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await service.close();
  const nextGeneration = "d".repeat(64);
  const nextActivationToken = Buffer.alloc(32, 73).toString("base64url");
  service = await configuredNativeGitBundleServer({ workflowCompiler: dimWorkflowCompiler,
    config: parseNativeGitBundleConfig(native), stateDirectory: path.join(root, "native-service"),
    readinessToken: Buffer.alloc(32, 72).toString("base64url"), activationToken: nextActivationToken, expectedGenerationId: nextGeneration });
  assert.equal(await service.listen("127.0.0.1", Number(new URL(endpoint).port)), endpoint);
  const reactivated = await fetch(`${endpoint}/v1/activation`, { method: "POST",
    headers: { authorization: `Bearer ${nextActivationToken}`, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, generationId: nextGeneration }) });
  assert.equal(reactivated.status, 200);
  await git(["fetch", "origin"], false);
  const reconnected = await connectControlPlane(operator, { endpoint, outputDirectory: path.join(root, "reconnected") });
  await saveControlPlaneSelection({ hostConnectionFile: path.join(reconnected.directory, "host.json"),
    importerConnectionFile: path.join(reconnected.directory, "importer.json") });
  delete process.env.DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE;
  await ensureManagedWorkspace(await store.read(name), { runner, store });
  const refreshed = await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(managedRoot, record.id));
  assert.deepEqual(refreshed, { ...attachment, connectionFile: path.join(reconnected.directory, "host.json") });
  await git(["fetch", "origin"]);
  assert.equal((await git(["rev-parse", "HEAD"])).stdout.trim(), beforeReconnect);
  const third = await runtime.run(record, ["sh", "-c", "printf 'reconnected proposal\\n' >> README.md && git add README.md && git commit -m reconnected"]);
  assert.equal(third.exitCode, 0, third.stderr);
  await git(["push", "origin"]);
  console.log("generation reconnect keeps the checkout, scoped grant and proposal namespace usable: passed");
  console.log("human approval and checked promotion preserve the persistent workspace's scoped Git access: passed");
  console.log("single Sysbox workspace, core record, scoped broker, real proposal push and protected/foreign denials: passed");
  const networkBefore = (await runner.run("docker", ["network", "inspect", resources.network, "--format", "{{.Id}}"])).stdout.trim();
  await base.stop(name);
  assert.equal((await fetch(`${broker}/v1/projects/example/repositories/app.git/info/refs?service=git-upload-pack`, { headers: auth })).status, 409);
  await base.start(name); await ensureManagedWorkspace(await store.read(name), { runner, store });
  await base.recreate(name); await ensureManagedWorkspace(await store.read(name), { runner, store });
  assert.equal((await runner.run("docker", ["network", "inspect", resources.network, "--format", "{{.Id}}"])).stdout.trim(), networkBefore);
  await git(["fetch", "origin"]);
  await base.discard(name);
  const remainsAuthorized = await fetch(`${broker}/health`, { headers: auth, signal: AbortSignal.timeout(500) })
    .then((response) => response.status === 200, () => false);
  assert.equal(remainsAuthorized, false);
  console.log("shared stop/start/recreate retains network+checkout+Git, discard immediately revokes broker: passed");
} finally {
  const cleanupFailures: unknown[] = [];
  let remaining;
  try { remaining = await store.read(name); }
  catch (error) { if (!(error instanceof Error && error.name === "MissingRecordError")) cleanupFailures.push(error); }
  if (remaining) { try { await base.discard(name); } catch (error) { cleanupFailures.push(error); } }
  try { await service?.close(); } catch (error) { cleanupFailures.push(error); }
  for (const [key, value] of Object.entries(oldEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, `native workspace cleanup failed; disposable state retained at ${root}`);
  // Project readiness roots intentionally become readonly; restore only this disposable fixture for cleanup.
  execFileSync("/usr/bin/chmod", ["-R", "u+rwX", root]);
  await rm(root, { recursive: true, force: true });
}

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
