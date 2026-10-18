import { dirname } from "node:path";
import { prepareNativeProjectFixtureRootForRemoval } from "../../cli/test/nativeProjectFixtureCleanup.js";
import { execFile } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { LifecycleState } from "../../../../core/packages/managed/src/lifecycleState.js";
import { lifecycleOptionsForBackend } from "../../../../core/packages/managed/src/lifecycleOptions.js";
import { loadNativeControlPlaneConnection } from "../../../../core/packages/managed/src/nativeControlPlaneConnection.js";
import { NativeProjectPendingStore } from "../../../../core/packages/managed/src/nativeProjectPendingStore.js";
import { createNodeNativeGitRootImporterClient } from "../../../../core/packages/managed/src/nativeGitRootImporterClient.js";
import { serveNativeWorkspaceGit } from "../../../../core/packages/managed/src/nativeWorkspaceGitBroker.js";
import type { NativeWorkspaceRecord } from "../../../../core/packages/managed/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { workspaceAgentContainerLabels, workspaceAgentIdentity, workspaceAgentNetworkLabels,
  workspaceAgentVolumeLabels } from "../../../../core/packages/managed/src/workspaceAgentRuntime.js";
import { workspaceRootSnapshotPath } from "../../../../core/packages/managed/src/workspaceLifecycleTypes.js";
import { setupWorkspaceLocked } from "../../../../core/packages/managed/src/workspaceSetup.js";
import { cleanupNativeProjectFixtures, nativeFixture } from "../../cli/test/nativeProjectCommandsFixture.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";

const runFile = promisify(execFile);
const agentId = "a".repeat(64);
const imageId = `sha256:${"f".repeat(64)}`;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()))));
  await cleanupNativeProjectFixtures();
});

it("grants native checkout reads only after durable setting-up and grants writes only after durable ready", async () => {
  // Given
  const fixture = await nativeFixture();
  const connection = await loadNativeControlPlaneConnection(fixture.controlPath);
  const projects = new NativeProjectPendingStore(fixture.stateRoot);
  await projects.admit("acme", await createNodeNativeGitRootImporterClient(fixture.importerPath),
    AbortSignal.timeout(10_000));
  const project = await projects.ready("acme", connection, AbortSignal.timeout(10_000));
  const state = new LifecycleState(fixture.stateRoot);
  const workspace = nativeWorkspace(fixture.commit, fixture.tree, project);
  await mkdir(workspaceRootSnapshotPath(fixture.stateRoot, workspace), { recursive: true });
  await state.claimWorkspace(workspace);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://broker");
    void state.readWorkspace(workspace.name).then((current) => {
      if (current.schemaVersion !== 9) throw new TypeError("expected a native workspace");
      return serveNativeWorkspaceGit({ stateRoot: fixture.stateRoot, connection, workspace: current,
        request, response, url, now: fixture.leaseClock });
    }).catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("native broker did not listen");
  const repositoryUrl = `http://127.0.0.1:${address.port}/api/native-git/v1/projects/project-a/repositories/root.git`;
  const runner = new NativeCheckoutRunner(workspace, workspaceRootSnapshotPath(fixture.stateRoot, workspace), repositoryUrl);

  // When
  const result = await setupWorkspaceLocked(runner, lifecycleOptionsForBackend("sysbox", {
    DIM_STATE_ROOT: fixture.stateRoot,
    DIM_WORKSPACE_IMAGE: "dim-workspace:test"
  }), state, workspace);

  // Then
  expect(result.phase).toBe("ready");
  expect(runner.checkoutReadSucceeded).toBe(true);
  expect(runner.checkoutWriteDenied).toBe(true);
  expect(runner.readyWriteSucceeded).toBe(true);
  await prepareNativeProjectFixtureRootForRemoval(dirname(fixture.stateRoot));
  await rm(workspaceRootSnapshotPath(fixture.stateRoot, workspace), { recursive: true, force: true });
});

it("publishes setup-error and closes native reads and writes when checkout fails after relay start", async () => {
  // Given
  const fixture = await nativeFixture();
  const connection = await loadNativeControlPlaneConnection(fixture.controlPath);
  const projects = new NativeProjectPendingStore(fixture.stateRoot);
  await projects.admit("acme", await createNodeNativeGitRootImporterClient(fixture.importerPath),
    AbortSignal.timeout(10_000));
  const project = await projects.ready("acme", connection, AbortSignal.timeout(10_000));
  const state = new LifecycleState(fixture.stateRoot);
  const workspace = nativeWorkspace(fixture.commit, fixture.tree, project);
  await mkdir(workspaceRootSnapshotPath(fixture.stateRoot, workspace), { recursive: true });
  await state.claimWorkspace(workspace);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://broker");
    void state.readWorkspace(workspace.name).then((current) => {
      if (current.schemaVersion !== 9) throw new TypeError("expected a native workspace");
      return serveNativeWorkspaceGit({ stateRoot: fixture.stateRoot, connection, workspace: current,
        request, response, url, now: fixture.leaseClock });
    }).catch((error: unknown) => response.writeHead(500).end(error instanceof Error ? error.message : String(error)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("native broker did not listen");
  const repositoryUrl = `http://127.0.0.1:${address.port}/api/native-git/v1/projects/project-a/repositories/root.git`;
  const runner = new NativeCheckoutRunner(workspace, workspaceRootSnapshotPath(fixture.stateRoot, workspace),
    repositoryUrl, true);

  // When
  await expect(setupWorkspaceLocked(runner, lifecycleOptionsForBackend("sysbox", {
    DIM_STATE_ROOT: fixture.stateRoot, DIM_WORKSPACE_IMAGE: "dim-workspace:test"
  }), state, workspace)).rejects.toThrow(/injected checkout failure/);

  // Then
  await expect(state.readWorkspace(workspace.name)).resolves.toMatchObject({ phase: "setup-error" });
  expect(runner.setupErrorPhasePublished).toBe(true);
  await expect(runFile("/usr/bin/git", ["ls-remote", repositoryUrl])).rejects.toBeDefined();
  expect(await receivePackStatus(repositoryUrl)).toBe(409);
});

class NativeCheckoutRunner implements StreamingCommandRunner {
  readonly resources = new Set<string>();
  checkoutReadSucceeded = false;
  checkoutWriteDenied = false;
  readyWriteSucceeded = false;
  setupErrorPhasePublished = false;

  constructor(
    private readonly workspace: NativeWorkspaceRecord,
    private readonly snapshot: string,
    private readonly repositoryUrl: string,
    private readonly failCheckout = false
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    if (args[0] === "info") return result(command, args, JSON.stringify({ "sysbox-runc": {} }));
    if (args[0] === "image") return result(command, args, imageId);
    if (args[0] === "container" && args[1] === "inspect" && args.at(-1)?.includes("HostConfig.NanoCpus")) {
      return result(command, args, args[2] === agentId
        ? "1500000000|3221225472|3221225472|1536" : "500000000|1073741824|1073741824|512");
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === this.workspace.containerName) {
      return result(command, args, workspaceContainerInspect(this.workspace, { id: "outer-id", rootSnapshotPath: this.snapshot }));
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === "outer-id") {
      return result(command, args, "172.31.0.2");
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === workspaceAgentIdentity(this.workspace).containerName) {
      return result(command, args, agentInspect(this.workspace));
    }
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
      const name = args[2] ?? "";
      if (!this.resources.has(name)) return missing(command, args, args[0], name);
      const values = args[0] === "network" ? workspaceAgentNetworkLabels(this.workspace)
        : workspaceAgentVolumeLabels(this.workspace, name.endsWith("-home") ? "agent-home"
          : name.endsWith("-docker") ? "agent-docker" : "agent-checkout");
      return result(command, args, labels(values));
    }
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "create") {
      this.resources.add(args.at(-1) ?? "");
      return result(command, args);
    }
    if (args[0] === "network" && args[1] === "connect") return result(command, args);
    if (args[0] === "update") return result(command, args);
    if (args[0] === "exec" && args.at(-1) === "ensure") {
      return result(command, args, JSON.stringify({ schemaVersion: 1, status: "ready", pid: 1,
        processStart: "1", configHash: "a".repeat(64), host: "172.31.0.2", port: 19_419 }));
    }
    if (args[0] === "exec" && args.includes("dim-agent-checkout")) {
      await runFile("/usr/bin/git", ["ls-remote", this.repositoryUrl]);
      this.checkoutReadSucceeded = true;
      this.checkoutWriteDenied = await receivePackStatus(this.repositoryUrl) === 409;
      if (this.failCheckout) {
        return { command, args, stdout: "", stderr: "injected checkout failure", exitCode: 1 };
      }
      return result(command, args);
    }
    if (args[0] === "exec" && args.at(-2) === "phase" && args.at(-1) === "ready") {
      this.readyWriteSucceeded = await receivePackStatus(this.repositoryUrl) === 200;
      return result(command, args);
    }
    if (args[0] === "exec" && args.at(-2) === "phase" && args.at(-1) === "setup-error") {
      this.setupErrorPhasePublished = true;
      return result(command, args);
    }
    return result(command, args);
  }

  async runStreaming(): Promise<number> { return 0; }
}

async function receivePackStatus(repositoryUrl: string): Promise<number> {
  const target = new URL(repositoryUrl);
  target.pathname = `${target.pathname}/info/refs`;
  target.search = "service=git-receive-pack";
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(target, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

function nativeWorkspace(commit: string, tree: string,
  project: Awaited<ReturnType<NativeProjectPendingStore["ready"]>>): NativeWorkspaceRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 9, workspaceId: Buffer.alloc(32, 31).toString("base64url"), name: "work-1",
    projectId: "project-a", projectName: "acme", rootRepositoryAlias: "root", rootRef: "refs/heads/main",
    rootCommit: commit, workspaceDataPath: "/var/lib/dim/workspace-data", environment: "recommended",
    phase: "creating", profiles: [], composeProjectName: "dim-work-1", containerName: "dim-ws-work-1",
    networkName: "bridge", dockerVolumeName: "dim-ws-work-1-docker", runtimeBackend: "sysbox", kvm: false,
    cpuCount: "2", memory: "4g", pidsLimit: "2048", routes: [], gitUserName: "DIM Test",
    gitUserEmail: "dim@example.invalid", hostAliases: {}, projectManifestPath: "/run/dim/project.json",
    createdAt: now, updatedAt: now,
    source: { kind: "native", serviceId: "native-main",
      snapshot: { projectId: "project-a", repositoryId: "root", protectedRef: "refs/heads/main", commit, tree },
      policyRevision: project.reviewPolicy.policyRevision,
      requiredReviewRevision: project.reviewPolicy.requiredReviewRevision,
      requiredJobSetRevision: project.reviewPolicy.requiredJobSetRevision }
  };
}

function agentInspect(record: NativeWorkspaceRecord): string {
  const identity = workspaceAgentIdentity(record);
  return [agentId, "true", imageId, "sysbox-runc", "false", labels(workspaceAgentContainerLabels(record)),
    JSON.stringify([
      { Type: "volume", Name: identity.homeVolumeName, Source: `/docker/${identity.homeVolumeName}`, Destination: "/home/dim", RW: true },
      { Type: "volume", Name: identity.checkoutVolumeName, Source: `/docker/${identity.checkoutVolumeName}`, Destination: "/workspace", RW: true },
      { Type: "volume", Name: identity.dockerVolumeName, Source: `/docker/${identity.dockerVolumeName}`, Destination: "/var/lib/docker", RW: true }
    ])].join("|");
}

function labels(values: readonly string[]): string {
  return JSON.stringify(Object.fromEntries(values.map((value) => value.split("=", 2))));
}

function result(command: string, args: string[], stdout = ""): CommandResult {
  return { command, args, stdout, stderr: "", exitCode: 0 };
}

function missing(command: string, args: string[], kind: string, name: string): CommandResult {
  return { command, args, stdout: "", stderr: `Error: No such ${kind}: ${name}`, exitCode: 1 };
}
