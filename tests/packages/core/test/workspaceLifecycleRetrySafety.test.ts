import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { discardWorkspaceAgentResources, reconcileWorkspaceAgent } from "../../../../core/packages/core/src/workspaceAgentLifecycle.js";
import { workspaceAgentContainerLabels, workspaceAgentIdentity, workspaceAgentNetworkLabels,
  workspaceAgentVolumeLabels } from "../../../../core/packages/core/src/workspaceAgentRuntime.js";
import { discardWorkspace } from "../../../../core/packages/core/src/workspaceDiscard.js";
import { workspaceRootSnapshotPath } from "../../../../core/packages/core/src/workspaceLifecycleTypes.js";
import { reconcileWorkspaceRuntimeState } from "../../../../core/packages/core/src/workspaceState.js";
import { setupWorkspaceLocked } from "../../../../core/packages/core/src/workspaceSetup.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";

const agentId = "a".repeat(64);
const imageId = `sha256:${"f".repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("recommended workspace retry safety", () => {
  it("recognizes Docker's exact missing-volume diagnostic during cleanup", async () => {
    const record = fixture();
    const calls: string[][] = [];
    const runner = runnerFrom(async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "container") return result(command, args, 1, "", `Error: No such container: ${args[2]}`);
      if (args[0] === "volume") {
        return result(command, args, 1, "", `Error response from daemon: get ${args[2]}: no such volume`);
      }
      return result(command, args, 1, "", `Error response from daemon: network ${args[2]} not found`);
    });

    await expect(discardWorkspaceAgentResources(runner, record, false)).resolves.toBeUndefined();
    expect(calls.some((call) => call[2] === "create" || call[2] === "rm")).toBe(false);
  });

  it("waits for nested Docker readiness before initializing checkout", async () => {
    const record = fixture();
    let agentExists = false;
    const resources = new Set<string>();
    const calls: string[][] = [];
    let readinessAttempts = 0;
    const runner = runnerFrom(async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "info") return result(command, args, 0, JSON.stringify({ "sysbox-runc": {} }));
      if (args[0] === "image") return result(command, args, 0, imageId);
      if ((args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
        const name = args[2] ?? "";
        if (!resources.has(name)) return result(command, args, 1, "", missingResource(args[0], name));
        const resourceLabels = args[0] === "network" ? workspaceAgentNetworkLabels(record)
          : workspaceAgentVolumeLabels(record, name.endsWith("-home") ? "agent-home"
            : name.endsWith("-checkout") ? "agent-checkout" : "agent-docker");
        return result(command, args, 0, labels(resourceLabels));
      }
      if ((args[0] === "network" || args[0] === "volume") && args[1] === "create") {
        resources.add(args.at(-1) ?? "");
        return result(command, args);
      }
      if (args[0] === "network" && args[1] === "connect") return result(command, args);
      if (args[0] === "container" && args[1] === "inspect" && args.at(-1)?.includes("HostConfig.NanoCpus")) {
        return result(command, args, 0, args[2] === agentId
          ? "1500000000|3221225472|3221225472|1536"
          : "500000000|1073741824|1073741824|512");
      }
      if (args[0] === "container" && args[1] === "inspect" && args[2] === "outer-id") {
        return result(command, args, 0, "172.31.0.2");
      }
      if (args[0] === "container" && args[1] === "inspect") {
        return agentExists ? result(command, args, 0, agentInspect(record))
          : result(command, args, 1, "", `Error: No such container: ${args[2]}`);
      }
      if (args[0] === "run") { agentExists = true; return result(command, args, 0, agentId); }
      if (args[0] === "update") return result(command, args);
      if (args[0] === "exec" && args.at(-2) === "docker" && args.at(-1) === "info") {
        readinessAttempts += 1;
        return readinessAttempts < 2
          ? result(command, args, 1, "", "daemon unavailable")
          : result(command, args);
      }
      if (args[0] === "exec" && args.at(-1) === "ensure") {
        return result(command, args, 0, JSON.stringify({ schemaVersion: 1, status: "ready", pid: 1,
          processStart: "1", configHash: "a".repeat(64), host: "172.31.0.2", port: 19_419 }));
      }
      return result(command, args);
    });

    await expect(reconcileWorkspaceAgent(runner, {
      options: lifecycleOptionsForBackend("sysbox"), record, outerContainerId: "outer-id"
    })).resolves.toBe(agentId);
    expect(readinessAttempts).toBe(2);
    expect(calls.some((call) => call.includes("dim-agent-checkout"))).toBe(true);
  });

  it.each([
    { running: false, mountedRoot: undefined, phase: "stopped" },
    { running: true, mountedRoot: "/foreign/root", phase: "error" }
  ] as const)("stops the agent when outer ownership is not runnable: $phase", async (testCase) => {
    const root = await mkdtemp(join(tmpdir(), "dim-runtime-reconcile-"));
    roots.push(root);
    const record = fixture();
    const state = new LifecycleState(root);
    await state.claimWorkspace(record);
    const calls: string[][] = [];
    const runner = runnerFrom(async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "container" && args[1] === "inspect" && args[2] === record.containerName) {
        return testCase.mountedRoot === undefined
          ? result(command, args, 1, "", `Error: No such container: ${record.containerName}`)
          : result(command, args, 0, workspaceContainerInspect(record, {
            id: "c".repeat(64), running: testCase.running, rootSnapshotPath: testCase.mountedRoot
          }));
      }
      if (args[0] === "container" && args[1] === "inspect") return result(command, args, 0, agentInspect(record));
      return result(command, args);
    });

    const reconciled = await reconcileWorkspaceRuntimeState(runner, state, root, record);

    expect(reconciled.phase).toBe(testCase.phase);
    expect(calls).toContainEqual(["docker", "stop", agentId]);
  });

  it("refuses recommended volume retention before state or runtime mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-discard-retain-"));
    roots.push(root);
    const record = fixture();
    const state = new LifecycleState(root);
    await state.claimWorkspace(record);
    const runner = runnerFrom(async (command, args) => result(command, args));

    await expect(discardWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }),
      record.name, true)).rejects.toThrow(/does not support --keep-volume/);
    await expect(state.readWorkspace(record.name)).resolves.toEqual(record);
  });

  it("rolls ready state back to setup-error when relay write enablement fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-relay-ready-failure-"));
    roots.push(root);
    const record = { ...fixture(), phase: "setting-up" as const };
    await mkdir(workspaceRootSnapshotPath(root, record), { recursive: true });
    const state = new LifecycleState(root);
    await state.claimWorkspace(record);
    const calls: string[][] = [];
    const runner = runnerFrom(async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "info") return result(command, args, 0, JSON.stringify({ "sysbox-runc": {} }));
      if (args[0] === "image") return result(command, args, 0, imageId);
      if ((args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
        const name = args[2] ?? "";
        const values = args[0] === "network" ? workspaceAgentNetworkLabels(record)
          : workspaceAgentVolumeLabels(record, name.endsWith("-home") ? "agent-home"
            : name.endsWith("-checkout") ? "agent-checkout" : "agent-docker");
        return result(command, args, 0, labels(values));
      }
      if (args[0] === "container" && args[1] === "inspect" && args.at(-1)?.includes("HostConfig.NanoCpus")) {
        return result(command, args, 0, args[2] === agentId
          ? "1500000000|3221225472|3221225472|1536" : "500000000|1073741824|1073741824|512");
      }
      if (args[0] === "container" && args[1] === "inspect" && args[2] === record.containerName) {
        return result(command, args, 0, workspaceContainerInspect(record, {
          id: "c".repeat(64), rootSnapshotPath: workspaceRootSnapshotPath(root, record)
        }));
      }
      if (args[0] === "container" && args[1] === "inspect" && args[2] === workspaceAgentIdentity(record).containerName) {
        return result(command, args, 0, agentInspect(record));
      }
      if (args[0] === "container" && args[1] === "inspect") return result(command, args, 0, "172.31.0.2");
      if (args[0] === "exec" && args.at(-1) === "ensure") {
        return result(command, args, 0, JSON.stringify({ schemaVersion: 1, status: "ready", pid: 1,
          processStart: "1", configHash: "a".repeat(64), host: "172.31.0.2", port: 19_419 }));
      }
      if (args[0] === "exec" && args.at(-2) === "phase" && args.at(-1) === "ready") {
        return result(command, args, 1, "", "injected relay failure");
      }
      return result(command, args);
    });

    await expect(setupWorkspaceLocked(runner, lifecycleOptionsForBackend("sysbox", {
      DIM_STATE_ROOT: root, DIM_WORKSPACE_IMAGE: "dim-workspace:test"
    }), state, record)).rejects.toThrow(/injected relay failure/);
    await expect(state.readWorkspace(record.name)).resolves.toMatchObject({
      phase: "setup-error", error: expect.stringMatching(/injected relay failure/)
    });
    expect(calls.filter((call) => call.at(-2) === "phase").map((call) => call.at(-1)))
      .toEqual(["ready"]);
    expect(calls).toContainEqual(["docker", "stop", "c".repeat(64)]);
  });

  it("checks outer root ownership before deleting agent resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-discard-ownership-"));
    roots.push(root);
    const record = fixture();
    const state = new LifecycleState(root);
    await state.claimWorkspace(record);
    await mkdir(workspaceRootSnapshotPath(root, record), { recursive: true });
    const calls: string[][] = [];
    const runner = runnerFrom(async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "container" && args[1] === "inspect" && args[2] === record.containerName) {
        return result(command, args, 0, workspaceContainerInspect(record, {
          id: "c".repeat(64), rootSnapshotPath: "/foreign/root"
        }));
      }
      return result(command, args);
    });

    await expect(discardWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }),
      record.name)).rejects.toThrow(/root does not match/);
    expect(calls.some((call) => call.includes(workspaceAgentIdentity(record).containerName))).toBe(false);
  });
});

function runnerFrom(run: StreamingCommandRunner["run"]): StreamingCommandRunner {
  return { run, async runStreaming(): Promise<number> { return 0; } };
}

function result(command: string, args: string[], exitCode = 0, stdout = "", stderr = ""): CommandResult {
  return { command, args, exitCode, stdout, stderr };
}

function missingResource(kind: string, name: string): string {
  return kind === "volume" ? `Error response from daemon: get ${name}: no such volume`
    : `Error response from daemon: network ${name} not found`;
}

function labels(values: readonly string[]): string {
  return JSON.stringify(Object.fromEntries(values.map((value) => value.split("=", 2))));
}

function agentInspect(record: WorkspaceRecord): string {
  const identity = workspaceAgentIdentity(record);
  return [agentId, "true", imageId, "sysbox-runc", "false", labels(workspaceAgentContainerLabels(record)),
    JSON.stringify([
      { Type: "volume", Name: identity.homeVolumeName, Source: `/docker/${identity.homeVolumeName}`, Destination: "/home/dim", RW: true },
      { Type: "volume", Name: identity.checkoutVolumeName, Source: `/docker/${identity.checkoutVolumeName}`, Destination: "/workspace", RW: true },
      { Type: "volume", Name: identity.dockerVolumeName, Source: `/docker/${identity.dockerVolumeName}`, Destination: "/var/lib/docker", RW: true }
    ])].join("|");
}

function fixture(): WorkspaceRecord {
  return { schemaVersion: 8, workspaceId: "A".repeat(43), name: "work-1", projectId: "project-id",
    projectName: "project", rootRepositoryAlias: "root", rootRef: "refs/heads/main", rootCommit: "b".repeat(40),
    workspaceDataPath: "/var/lib/dim/workspace-data", environment: "recommended", phase: "ready", profiles: [],
    composeProjectName: "dim-work-1", containerName: "dim-ws-work-1", networkName: "dim-control",
    dockerVolumeName: "dim-ws-work-1-docker", runtimeBackend: "sysbox", kvm: false, cpuCount: "2",
    memory: "4g", pidsLimit: "2048", routes: [], gitUserName: "Agent", gitUserEmail: "agent@example.invalid",
    gitBaseUrl: "http://dim-gitea:3000/dim-project", hostAliases: {}, projectManifestPath: "/run/dim/project.json",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}
