import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { workspaceAgentContainerLabels, workspaceAgentIdentity } from "../../../../core/packages/core/src/workspaceAgentRuntime.js";
import { workspaceRootSnapshotPath } from "../../../../core/packages/core/src/workspaceLifecycleTypes.js";
import { reconcileWorkspaceRuntimeState } from "../../../../core/packages/core/src/workspaceState.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";

const roots: string[] = [];
const outerId = "c".repeat(64);
const agentId = "a".repeat(64);
const imageId = `sha256:${"f".repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("heals a ready relay fence only after outer and agent ownership validate", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-relay-recovery-"));
  roots.push(root);
  const record = fixture();
  const state = new LifecycleState(root);
  await state.claimWorkspace(record);
  const calls: string[][] = [];
  const runner: StreamingCommandRunner = {
    async run(command, args): Promise<CommandResult> {
      calls.push([command, ...args]);
      if (args[0] === "container" && args[1] === "inspect" && args[2] === record.containerName) {
        return result(command, args, workspaceContainerInspect(record, {
          id: outerId, rootSnapshotPath: workspaceRootSnapshotPath(root, record)
        }));
      }
      if (args[0] === "container" && args[1] === "inspect") return result(command, args, agentInspect(record));
      return result(command, args);
    },
    async runStreaming(): Promise<number> { return 0; }
  };

  const reconciled = await reconcileWorkspaceRuntimeState(runner, state, root, record);

  expect(reconciled.phase).toBe("ready");
  expect(calls).toContainEqual([
    "docker", "exec", outerId, "node", "/usr/local/lib/dim/agent-git-relay.mjs", "phase", "ready"
  ]);
});

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

function agentInspect(record: WorkspaceRecord): string {
  const identity = workspaceAgentIdentity(record);
  const labels = JSON.stringify(Object.fromEntries(workspaceAgentContainerLabels(record)
    .map((value) => value.split("=", 2))));
  return [agentId, "true", imageId, "sysbox-runc", "false", labels, JSON.stringify([
    { Type: "volume", Name: identity.homeVolumeName, Source: `/docker/${identity.homeVolumeName}`, Destination: "/home/dim", RW: true },
    { Type: "volume", Name: identity.checkoutVolumeName, Source: `/docker/${identity.checkoutVolumeName}`, Destination: "/workspace", RW: true },
    { Type: "volume", Name: identity.dockerVolumeName, Source: `/docker/${identity.dockerVolumeName}`, Destination: "/var/lib/docker", RW: true }
  ])].join("|");
}

function result(command: string, args: string[], stdout = ""): CommandResult {
  return { command, args, stdout, stderr: "", exitCode: 0 };
}
