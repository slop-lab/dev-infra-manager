import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { globalAgent } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import { createNodeNativeGitRootImporterClient, LifecycleState, loadNativeControlPlaneConnection,
  NativeProjectPendingStore, proveNativeProjectReadiness, serveNativeWorkspaceGit,
  type NativeWorkspaceRecord } from "../../../../core/packages/core/src/index.js";
import { cleanupNativeProjectFixtures, nativeFixture } from "../../cli/test/nativeProjectCommandsFixture.js";
import { nativeTlsProxy, type NativeTlsFixture } from "./nativeTlsFixture.js";

const runFile = promisify(execFile);
const roots: string[] = [];
const children: ChildProcess[] = [];
const tlsFixtures: NativeTlsFixture[] = [];
const originalCa = globalAgent.options.ca;

afterEach(async () => {
  await cleanupNativeProjectFixtures();
  await Promise.all(children.splice(0).map(stopChild));
  if (originalCa === undefined) delete globalAgent.options.ca;
  else globalAgent.options.ca = originalCa;
  await Promise.all(tlsFixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("native workspace broker refreshes leases and preserves proposal-only Git across service restart", async () => {
  // Given
  const fixture = await nativeFixture();
  const localConnection = await loadNativeControlPlaneConnection(fixture.controlPath);
  const projects = new NativeProjectPendingStore(fixture.stateRoot);
  await projects.admit("acme", await createNodeNativeGitRootImporterClient(fixture.importerPath),
    AbortSignal.timeout(10_000));
  const project = await projects.ready("acme", localConnection, AbortSignal.timeout(10_000));
  const control: unknown = JSON.parse(await readFile(fixture.controlPath, "utf8"));
  if (typeof control !== "object" || control === null || Array.isArray(control)) {
    throw new TypeError("native control-plane fixture is invalid");
  }
  const nativeGitEndpoint = Reflect.get(Reflect.get(control, "nativeGit"), "endpoint");
  if (typeof nativeGitEndpoint !== "string") throw new TypeError("native Git endpoint is missing");
  const tls = await nativeTlsProxy(nativeGitEndpoint);
  tlsFixtures.push(tls);
  globalAgent.options.ca = tls.ca;
  await writeFile(fixture.controlPath, JSON.stringify({ ...control, nativeGit: {
    ...Reflect.get(control, "nativeGit"), transport: "https", endpoint: tls.origin
  } }), { mode: 0o600 });
  const connection = await loadNativeControlPlaneConnection(fixture.controlPath);
  await proveNativeProjectReadiness(connection, project, AbortSignal.timeout(5_000));
  const state = new LifecycleState(fixture.stateRoot);
  const workspaceId = Buffer.alloc(32, 31).toString("base64url");
  const now = new Date().toISOString();
  const workspace: NativeWorkspaceRecord = {
    schemaVersion: 9, workspaceId, name: "work-1", projectId: "project-a", projectName: "acme",
    rootRepositoryAlias: "root", rootRef: "refs/heads/main", rootCommit: fixture.commit,
    workspaceDataPath: "/var/lib/dim/workspace-data", phase: "ready", profiles: [],
    composeProjectName: "dim-work-1", containerName: "dim-ws-work-1", networkName: "bridge",
    dockerVolumeName: "dim-ws-work-1-docker", runtimeBackend: "sysbox", kvm: false,
    cpuCount: "2", memory: "4g", pidsLimit: "2048", routes: [], gitUserName: "DIM Test",
    gitUserEmail: "dim@example.invalid", hostAliases: {}, projectManifestPath: "/run/dim/project.json",
    createdAt: now, updatedAt: now,
    source: { kind: "native", serviceId: "native-main",
      snapshot: { projectId: "project-a", repositoryId: "root", protectedRef: "refs/heads/main",
        commit: fixture.commit, tree: fixture.tree }, policyRevision: project.reviewPolicy.policyRevision,
      requiredReviewRevision: project.reviewPolicy.requiredReviewRevision,
      requiredJobSetRevision: project.reviewPolicy.requiredJobSetRevision }
  };
  await state.claimWorkspace(workspace);
  const brokerToken = Buffer.alloc(32, 47).toString("base64url");
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${brokerToken}`);
    const url = new URL(request.url ?? "/", "http://broker");
    void loadNativeControlPlaneConnection(fixture.controlPath).then((currentConnection) =>
      serveNativeWorkspaceGit({ stateRoot: fixture.stateRoot, connection: currentConnection, workspace,
        request, response, url, now: fixture.leaseClock })).catch((error) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  const brokerSocket = join(fixture.stateRoot, "native-git-broker.sock");
  await new Promise<void>((resolve) => server.listen(brokerSocket, resolve));
  const proxyPort = await reservePort();
  const proxy = spawn(process.execPath, ["--import", "tsx",
    join(import.meta.dirname, "../../../../core/packages/controller-proxy/src/cli.ts"),
    "native-git", "--listen", `127.0.0.1:${proxyPort}`], {
    env: { ...process.env, DIM_CONTROLLER_SOCKET: brokerSocket,
      DIM_NATIVE_GIT_BROKER_TOKEN: brokerToken }, stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(proxy);
  await waitForProxy(proxyPort, proxy);
  const repositoryUrl = `http://127.0.0.1:${proxyPort}/v1/projects/project-a/repositories/root.git`;
  const clone = await mkdtemp("/tmp/dim-native-broker-");
  roots.push(clone);
  await runFile("/usr/bin/git", ["clone", repositoryUrl, clone]);
  await writeFile(join(clone, "proposal.txt"), "proposal\n");
  await runFile("/usr/bin/git", ["-C", clone, "add", "."]);
  await runFile("/usr/bin/git", ["-C", clone, "-c", "user.name=DIM Test", "-c",
    "user.email=dim@example.invalid", "commit", "-m", "proposal"]);

  // When
  await runFile("/usr/bin/git", ["-C", clone, "push", "origin", `HEAD:refs/heads/proposals/${workspaceId}/change`]);
  await assert.rejects(runFile("/usr/bin/git", ["-C", clone, "push", "origin", "HEAD:refs/heads/main"]));
  await assert.rejects(runFile("/usr/bin/git", ["-C", clone, "push", "origin", "HEAD:refs/heads/proposals/foreign/change"]));
  await assert.rejects(runFile("/usr/bin/git", ["-C", clone, "push", "origin", `:refs/heads/proposals/${workspaceId}/change`]));
  await runFile("/usr/bin/git", ["-C", clone, "reset", "--hard", "HEAD~1"]);
  await writeFile(join(clone, "replacement.txt"), "replacement\n");
  await runFile("/usr/bin/git", ["-C", clone, "add", "."]);
  await runFile("/usr/bin/git", ["-C", clone, "-c", "user.name=DIM Test", "-c",
    "user.email=dim@example.invalid", "commit", "-m", "replacement"]);
  await assert.rejects(runFile("/usr/bin/git", ["-C", clone, "push", "--force", "origin",
    `HEAD:refs/heads/proposals/${workspaceId}/change`]));
  fixture.advanceLeaseClock(31_000);
  await runFile("/usr/bin/git", ["-C", clone, "fetch", "origin"]);
  await fixture.rolloverNativeGit(false);
  const staleConnection = await loadNativeControlPlaneConnection(fixture.controlPath);
  assert.equal(staleConnection.nativeGit.generationId, fixture.importGenerationId);
  await assert.rejects(proveNativeProjectReadiness(staleConnection, project, AbortSignal.timeout(5_000)));
  const beforeStaleRequest = (await runFile("/usr/bin/git", ["--git-dir",
    join(fixture.serviceRoot, "project-a", "root.git"), "rev-parse",
    `refs/heads/proposals/${workspaceId}/change`])).stdout.trim();
  await assert.rejects(runFile("/usr/bin/git", ["ls-remote", repositoryUrl]));
  const afterStaleRequest = (await runFile("/usr/bin/git", ["--git-dir",
    join(fixture.serviceRoot, "project-a", "root.git"), "rev-parse",
    `refs/heads/proposals/${workspaceId}/change`])).stdout.trim();
  assert.equal(afterStaleRequest, beforeStaleRequest);
  await fixture.publishCurrentGeneration();
  await runFile("/usr/bin/git", ["ls-remote", repositoryUrl]);
  await writeFile(join(clone, "rollover.txt"), "generation B\n");
  await runFile("/usr/bin/git", ["-C", clone, "add", "."]);
  await runFile("/usr/bin/git", ["-C", clone, "-c", "user.name=DIM Test", "-c",
    "user.email=dim@example.invalid", "commit", "-m", "generation B"]);
  await runFile("/usr/bin/git", ["-C", clone, "push", "origin",
    `HEAD:refs/heads/proposals/${workspaceId}/generation-b`]);

  // Then
  const proposal = (await runFile("/usr/bin/git", ["--git-dir", join(fixture.serviceRoot, "project-a", "root.git"),
    "rev-parse", `refs/heads/proposals/${workspaceId}/change`])).stdout.trim();
  assert.match(proposal, /^[0-9a-f]{40}$/);
  assert.equal(project.importReceipt.generationId, fixture.importGenerationId);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForProxy(port: number, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`native Git proxy exited with ${child.exitCode}`);
    try {
      const socket = await import("node:net").then(({ createConnection }) => createConnection(port, "127.0.0.1"));
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.destroy();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("native Git proxy did not listen");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
