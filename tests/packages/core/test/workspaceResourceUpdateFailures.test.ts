import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptions } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { updateWorkspaceResources } from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { workspaceAgentContainerLabels, workspaceAgentIdentity } from "../../../../core/packages/core/src/workspaceAgentRuntime.js";
import type { WorkspaceResourceLimits } from "../../../../core/packages/core/src/workspaceResourceBudget.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";

const outerId = "workspace-container-id";
const agentId = "a".repeat(64);

describe("recommended workspace resource update failures", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("restores both runtime allocations when the agent update fails", async () => {
    // Given
    const { root, record, state, options } = await fixture(roots);
    const runner = new ResourceRunner(root, record, true);

    // When / Then
    await expect(updateWorkspaceResources(runner, options, record.name, {
      memory: "3g",
      pidsLimit: "1024"
    })).rejects.toThrow(/failed to update recommended workspace agent resources/);
    expect(runner.outer).toEqual({ cpuCount: "0.5", memory: "1073741824", pidsLimit: "512" });
    expect(runner.agent).toEqual({ cpuCount: "1.5", memory: "3221225472", pidsLimit: "1536" });
    await expect(state.readWorkspace(record.name)).resolves.toMatchObject({
      cpuCount: "2", memory: "4g", pidsLimit: "2048"
    });
  });

  it("restores runtime and durable state when publication fails", async () => {
    // Given
    const { root, record, state, options } = await fixture(roots);
    const runner = new ResourceRunner(root, record, false);
    vi.spyOn(LifecycleState.prototype, "writeWorkspace").mockRejectedValueOnce(new Error("publication failed"));

    // When / Then
    await expect(updateWorkspaceResources(runner, options, record.name, {
      memory: "3g",
      pidsLimit: "1024"
    })).rejects.toThrow(/publication failed/);
    expect(runner.outer).toEqual({ cpuCount: "0.5", memory: "1073741824", pidsLimit: "512" });
    expect(runner.agent).toEqual({ cpuCount: "1.5", memory: "3221225472", pidsLimit: "1536" });
    await expect(state.readWorkspace(record.name)).resolves.toMatchObject({
      cpuCount: "2", memory: "4g", pidsLimit: "2048"
    });
  });

  it("surfaces uncertain state when runtime compensation fails", async () => {
    // Given
    const { root, record, options } = await fixture(roots);
    const runner = new ResourceRunner(root, record, true, true);

    // When / Then
    await expect(updateWorkspaceResources(runner, options, record.name, {
      memory: "3g",
      pidsLimit: "1024"
    })).rejects.toThrow(/workspace resource state is uncertain.*restore previous workspace resources/);
  });
});

class ResourceRunner implements StreamingCommandRunner {
  outer: WorkspaceResourceLimits = { cpuCount: "0.5", memory: "1073741824", pidsLimit: "512" };
  agent: WorkspaceResourceLimits = { cpuCount: "1.5", memory: "3221225472", pidsLimit: "1536" };
  private failedAgentUpdate = false;
  private outerUpdates = 0;

  constructor(
    private readonly root: string,
    private readonly record: WorkspaceRecord,
    private readonly failAgentUpdate: boolean,
    private readonly failOuterRollback = false
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    if (args[0] === "container" && args[1] === "inspect") {
      if (args[2] === this.record.containerName) {
        return result(command, args, workspaceContainerInspect(this.record, {
          id: outerId,
          rootSnapshotPath: join(this.root, "assets", "project-roots", this.record.projectId, this.record.rootCommit)
        }));
      }
      if (args[2] === workspaceAgentIdentity(this.record).containerName) {
        return result(command, args, agentInspect(this.record));
      }
      if (args[2] === outerId) return result(command, args, resourceInspect(this.outer));
      if (args[2] === agentId) return result(command, args, resourceInspect(this.agent));
    }
    if (args[0] === "update") {
      const limits = updateLimits(args);
      const id = args.at(-1);
      if (id === outerId) {
        this.outerUpdates += 1;
        if (this.failOuterRollback && this.outerUpdates === 2) {
          return result(command, args, "", "outer rollback failed", 1);
        }
        this.outer = limits;
      }
      if (id === agentId) {
        this.agent = limits;
        if (this.failAgentUpdate && !this.failedAgentUpdate) {
          this.failedAgentUpdate = true;
          return result(command, args, "", "agent update failed", 1);
        }
      }
      return result(command, args);
    }
    return result(command, args, "", "unexpected command", 1);
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}

async function fixture(roots: string[]): Promise<{
  readonly root: string;
  readonly record: WorkspaceRecord;
  readonly state: LifecycleState;
  readonly options: ReturnType<typeof lifecycleOptions>;
}> {
  const root = await mkdtemp(join(tmpdir(), "dim-resource-failure-"));
  roots.push(root);
  await writeFile(join(root, "dim.json"), JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" }));
  const now = new Date().toISOString();
  const record: WorkspaceRecord = {
    schemaVersion: 8, workspaceId: "A".repeat(43), name: "work-1", projectId: "project-id", projectName: "project",
    rootRepositoryAlias: "root", rootRef: "refs/heads/main", rootCommit: "a".repeat(40),
    workspaceDataPath: "/var/lib/dim/workspace-data", environment: "recommended", phase: "ready", profiles: [],
    composeProjectName: "dim-work-1", containerName: "dim-ws-work-1", networkName: "dim-control",
    dockerVolumeName: "dim-ws-work-1-docker", runtimeBackend: "sysbox", kvm: false, cpuCount: "2", memory: "4g",
    pidsLimit: "2048", routes: [], gitUserName: "Agent", gitUserEmail: "agent@example.invalid",
    gitBaseUrl: "http://dim-gitea:3000/dim-project", hostAliases: {}, projectManifestPath: "/run/dim/project.json",
    createdAt: now, updatedAt: now
  };
  const state = new LifecycleState(root);
  await state.claimWorkspace(record);
  return {
    root,
    record,
    state,
    options: lifecycleOptions({ DIM_STATE_ROOT: root, DIM_CONFIG_PATH: join(root, "dim.json") })
  };
}

function agentInspect(record: WorkspaceRecord): string {
  const identity = workspaceAgentIdentity(record);
  const labels = JSON.stringify(Object.fromEntries(workspaceAgentContainerLabels(record).map((label) => label.split("=", 2))));
  const mounts = JSON.stringify([
    { Type: "volume", Name: identity.homeVolumeName, Source: `/volumes/${identity.homeVolumeName}`, Destination: "/home/dim", RW: true },
    { Type: "volume", Name: identity.checkoutVolumeName, Source: `/volumes/${identity.checkoutVolumeName}`, Destination: "/workspace", RW: true },
    { Type: "volume", Name: identity.dockerVolumeName, Source: `/volumes/${identity.dockerVolumeName}`, Destination: "/var/lib/docker", RW: true }
  ]);
  return `${agentId}|true|sha256:${"f".repeat(64)}|sysbox-runc|false|${labels}|${mounts}`;
}

function resourceInspect(limits: WorkspaceResourceLimits): string {
  return `${Math.round(Number(limits.cpuCount) * 1_000_000_000)}|${limits.memory}|${limits.memory}|${limits.pidsLimit}`;
}

function updateLimits(args: readonly string[]): WorkspaceResourceLimits {
  return {
    cpuCount: args[args.indexOf("--cpus") + 1] ?? "",
    memory: args[args.indexOf("--memory") + 1] ?? "",
    pidsLimit: args[args.indexOf("--pids-limit") + 1] ?? ""
  };
}

function result(command: string, args: string[], stdout = "", stderr = "", exitCode = 0): CommandResult {
  return { command, args, stdout, stderr, exitCode };
}
