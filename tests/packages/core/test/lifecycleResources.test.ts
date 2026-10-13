import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptions } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState, validateLifecycleName } from "../../../../core/packages/core/src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import {
  detectWorkspaceKvm,
  projectRuntimeManifest,
  resolveWorkspaceCapabilities,
  resolveWorkspaceKvm,
  restartWorkspace,
  updateWorkspaceResources,
  validateWorkspaceProfiles,
  validateWorkspaceResources,
  waitForInnerDocker,
  workspaceContainerArgs
} from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { workspaceRuntimePlan } from "../../../../core/packages/core/src/runtimeBackends.js";
import { rootRepositorySnapshot } from "./lifecycleFixture.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";
import { workspaceAgentContainerLabels, workspaceAgentIdentity } from "../../../../core/packages/core/src/workspaceAgentRuntime.js";

describe("project and workspace lifecycle", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-lifecycle-"));
    await writeFile(join(root, "dim.json"), JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

it("updates a claimed workspace container and persists its effective resources", async () => {
    const state = new LifecycleState(root);
    const now = new Date().toISOString();
    const record: WorkspaceRecord = {
      schemaVersion: 8,
      workspaceId: "A".repeat(43),
      name: "work-1",
      projectId: "project-id",
      projectName: "project",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      rootCommit: "a".repeat(40),
      workspaceDataPath: "/var/lib/dim/workspace-data",
      environment: "recommended",
      phase: "ready",
      profiles: [],
      composeProjectName: "dim-work-1",
      containerName: "dim-ws-work-1",
      networkName: "dim-control",
      dockerVolumeName: "dim-ws-work-1-docker",
      runtimeBackend: "sysbox",
      kvm: false,
      cpuCount: "2",
      memory: "4g",
      pidsLimit: "2048",
      routes: [],
      gitUserName: "Agent",
      gitUserEmail: "agent@example.invalid",
      gitBaseUrl: "http://dim-gitea:3000/dim-project",
      hostAliases: { "dim-gitea": ["172.20.0.2"] },
      projectManifestPath: "/run/dim/project.json",
      createdAt: now,
      updatedAt: now
    };
    await state.claimWorkspace(record);
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command: string, args: string[]): Promise<CommandResult> {
        calls.push([command, ...args]);
        if ((args[0] === "container" && args[1] === "inspect") || args[0] === "inspect") {
          if (args.includes("{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.PidsLimit}}")) {
            const agent = args[2] === "a".repeat(64);
            return { command, args, stdout: agent
              ? "1500000000|2415919104|2415919104|768\n"
              : "500000000|805306368|805306368|256\n", stderr: "", exitCode: 0 };
          }
          if (args[2] === "dim-agent-work-1") {
            const identity = workspaceAgentIdentity(record);
            const labels = JSON.stringify(Object.fromEntries(
              workspaceAgentContainerLabels(record).map((label) => label.split("=", 2))
            ));
            const mounts = JSON.stringify([
              { Type: "volume", Name: identity.homeVolumeName,
                Source: `/docker/volumes/${identity.homeVolumeName}/_data`, Destination: "/home/dim", RW: true },
              { Type: "volume", Name: identity.checkoutVolumeName,
                Source: `/docker/volumes/${identity.checkoutVolumeName}/_data`, Destination: "/workspace", RW: true },
              { Type: "volume", Name: identity.dockerVolumeName,
                Source: `/docker/volumes/${identity.dockerVolumeName}/_data`,
                Destination: "/var/lib/docker", RW: true }
            ]);
            return { command, args,
              stdout: `${"a".repeat(64)}|true|sha256:${"f".repeat(64)}|sysbox-runc|false|${labels}|${mounts}\n`,
              stderr: "", exitCode: 0 };
          }
          return { command, args, stdout: `${workspaceContainerInspect(record, {
            rootSnapshotPath: join(root, "assets", "project-roots", record.projectId, record.rootCommit)
          })}\n`, stderr: "", exitCode: 0 };
        }
        return { command, args, stdout: "dim-ws-work-1\n", stderr: "", exitCode: 0 };
      },
      async runStreaming(): Promise<number> {
        return 0;
      }
    };

    const options = lifecycleOptions({ DIM_STATE_ROOT: root, DIM_CONFIG_PATH: join(root, "dim.json") });
    const updated = await updateWorkspaceResources(runner, options, "work-1", {
      memory: "3g",
      pidsLimit: "1024"
    });
    expect(updated).toMatchObject({ cpuCount: "2", memory: "3g", pidsLimit: "1024" });
    expect(await state.readWorkspace("work-1")).toMatchObject({
      cpuCount: "2",
      memory: "3g",
      pidsLimit: "1024"
    });
    expect(calls).toContainEqual([
      "docker", "update",
      "--cpus", "0.5",
      "--memory", "805306368",
      "--memory-swap", "805306368",
      "--pids-limit", "256",
      "workspace-container-id"
    ]);
    expect(calls).toContainEqual([
      "docker", "update",
      "--cpus", "1.5",
      "--memory", "2415919104",
      "--memory-swap", "2415919104",
      "--pids-limit", "768",
      "a".repeat(64)
    ]);
  });
});
