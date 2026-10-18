import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  workspaceAgentContainerArgs,
  workspaceAgentContainerLabels,
  workspaceAgentIdentity,
  workspaceAgentNetworkLabels,
  workspaceAgentVolumeLabels
} from "../../../../core/packages/managed/src/workspaceAgentRuntime.js";
import { discardWorkspaceAgentResources } from "../../../../core/packages/managed/src/workspaceAgentLifecycle.js";
import type { WorkspaceRecord } from "../../../../core/packages/managed/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { inspectWorkspaceAgentContainer } from "../../../../core/packages/managed/src/workspaceAgentInspection.js";

const record = {
  schemaVersion: 9,
  workspaceId: "A".repeat(43),
  name: "work-1",
  projectId: "project-id",
  projectName: "project",
  rootRepositoryAlias: "root",
  rootRef: "refs/heads/main",
  rootCommit: "a".repeat(40),
  workspaceDataPath: "/var/lib/dim/workspace-data",
  phase: "ready",
  profiles: [],
  composeProjectName: "dim-work-1",
  containerName: "dim-ws-work-1",
  networkName: "bridge",
  dockerVolumeName: "dim-ws-work-1-docker",
  runtimeBackend: "sysbox",
  kvm: false,
  cpuCount: "2",
  memory: "4g",
  pidsLimit: "2048",
  routes: [],
  gitUserName: "Agent",
  gitUserEmail: "agent@example.invalid",
  hostAliases: {},
  projectManifestPath: "/run/dim/project.json",
  createdAt: "now",
  updatedAt: "now",
  source: {
    kind: "native",
    serviceId: "native-main",
    snapshot: { projectId: "project-id", repositoryId: "root", protectedRef: "refs/heads/main", commit: "a".repeat(40), tree: "b".repeat(40) },
    policyRevision: "c".repeat(64),
    requiredReviewRevision: "d".repeat(64),
    requiredJobSetRevision: "e".repeat(64)
  }
} satisfies WorkspaceRecord;

describe("recommended workspace agent runtime", () => {
  it("uses a DIM-owned unprivileged Sysbox container with persistent home and checkout", () => {
    const identity = workspaceAgentIdentity(record);
    const args = workspaceAgentContainerArgs(record, "sha256:" + "f".repeat(64));

    expect(identity).toEqual({
      containerName: "dim-agent-work-1",
      networkName: "dim-agent-work-1",
      homeVolumeName: "dim-agent-work-1-home",
      checkoutVolumeName: "dim-agent-work-1-checkout",
      dockerVolumeName: "dim-agent-work-1-docker"
    });
    expect(args).toEqual(expect.arrayContaining([
      "--runtime", "sysbox-runc",
      "--mount", "type=volume,source=dim-agent-work-1-home,target=/home/dim",
      "--mount", "type=volume,source=dim-agent-work-1-checkout,target=/workspace",
      "--mount", "type=volume,source=dim-agent-work-1-docker,target=/var/lib/docker",
      "--entrypoint", "/usr/local/bin/dim-agent-entrypoint",
      "--label", "dim.workspace-id=" + record.workspaceId,
      "--label", "dim.resource-budget=split-v1",
      "--label", "dim.resource-budget-role=agent",
      "--cpus", "1.5",
      "--memory", "3221225472",
      "--memory-swap", "3221225472",
      "--pids-limit", "1536",
      "sha256:" + "f".repeat(64)
    ]));
    expect(args).not.toContain("--privileged");
    expect(args.join(" ")).not.toMatch(/TOKEN|controller\.sock|docker\.sock|connection/i);
  });

  it("binds volume ownership to the exact workspace identity and resource", () => {
    const labels = workspaceAgentVolumeLabels(record, "agent-home");

    expect(labels).toEqual(expect.arrayContaining([
      "dim.managed=true",
      "dim.owner=dim",
      `dim.workspace-id=${record.workspaceId}`,
      "dim.resource=agent-home"
    ]));
  });

  it("uses the named Docker volume as the release-owned agent dockerd data-root", async () => {
    const entrypoint = await readFile(join(
      import.meta.dirname,
      "../../../../core/images/project-workspace/agent-entrypoint.bash"
    ), "utf8");

    expect(entrypoint).toMatch(/dockerd[\s\S]*--data-root=\/var\/lib\/docker/);
  });

  it("removes all owned volumes and disconnects the outer container before removing the network", async () => {
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args): Promise<CommandResult> {
        calls.push([command, ...args]);
        if (args[0] === "container" && args[1] === "inspect") {
          return { command, args, stdout: "", stderr: `Error: No such container: ${args[2]}`, exitCode: 1 };
        }
        if (args[0] === "network" && args[1] === "inspect") {
          return { command, args, stdout: jsonLabels(workspaceAgentNetworkLabels(record)), stderr: "", exitCode: 0 };
        }
        if (args[0] === "volume" && args[1] === "inspect") {
          const name = args[2] ?? "";
          const resource = name.endsWith("-home") ? "agent-home"
            : name.endsWith("-checkout") ? "agent-checkout" : "agent-docker";
          return { command, args, stdout: jsonLabels(workspaceAgentVolumeLabels(record, resource)), stderr: "", exitCode: 0 };
        }
        return { command, args, stdout: "", stderr: "", exitCode: 0 };
      },
      async runStreaming(): Promise<number> { return 0; }
    };

    await discardWorkspaceAgentResources(runner, record, false);

    const disconnect = calls.findIndex((call) => call[1] === "network" && call[2] === "disconnect");
    const remove = calls.findIndex((call) => call[1] === "network" && call[2] === "rm");
    expect(calls[disconnect]).toEqual([
      "docker", "network", "disconnect", "--force", "dim-agent-work-1", record.containerName
    ]);
    expect(disconnect).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(disconnect);
    expect(calls.filter((call) => call[1] === "volume" && call[2] === "rm").map((call) => call[3])).toEqual([
      "dim-agent-work-1-home",
      "dim-agent-work-1-checkout",
      "dim-agent-work-1-docker"
    ]);
  });

  it("rejects a label-compatible agent that is privileged", async () => {
    const identity = workspaceAgentIdentity(record);
    const mounts = dockerMounts(identity);
    const runner: StreamingCommandRunner = {
      async run(command, args): Promise<CommandResult> {
        return { command, args,
          stdout: `${"a".repeat(64)}|true|sha256:${"f".repeat(64)}|sysbox-runc|true|${jsonLabels(workspaceAgentContainerLabels(record))}|${mounts}`,
          stderr: "", exitCode: 0 };
      },
      async runStreaming(): Promise<number> { return 0; }
    };

    await expect(inspectWorkspaceAgentContainer(runner, record)).rejects.toThrow(/conflicts with DIM ownership/);
  });

  it("accepts real Docker volume inspect fields while validating names and absolute sources", async () => {
    const runner: StreamingCommandRunner = {
      async run(command, args): Promise<CommandResult> {
        return { command, args,
          stdout: `${"a".repeat(64)}|true|sha256:${"f".repeat(64)}|sysbox-runc|false|${jsonLabels(workspaceAgentContainerLabels(record))}|${dockerMounts(workspaceAgentIdentity(record))}`,
          stderr: "", exitCode: 0 };
      },
      async runStreaming(): Promise<number> { return 0; }
    };

    await expect(inspectWorkspaceAgentContainer(runner, record)).resolves.toEqual({
      id: "a".repeat(64),
      image: `sha256:${"f".repeat(64)}`,
      running: true
    });
  });
});

function jsonLabels(labels: readonly string[]): string {
  return JSON.stringify(Object.fromEntries(labels.map((label) => label.split("=", 2))));
}

function dockerMounts(identity: ReturnType<typeof workspaceAgentIdentity>): string {
  return JSON.stringify([
    { Type: "volume", Name: identity.homeVolumeName,
      Source: `/home/rootless/.local/share/docker/volumes/${identity.homeVolumeName}/_data`,
      Destination: "/home/dim", RW: true },
    { Type: "volume", Name: identity.checkoutVolumeName,
      Source: `/home/rootless/.local/share/docker/volumes/${identity.checkoutVolumeName}/_data`,
      Destination: "/workspace", RW: true },
    { Type: "volume", Name: identity.dockerVolumeName,
      Source: `/home/rootless/.local/share/docker/volumes/${identity.dockerVolumeName}/_data`,
      Destination: "/var/lib/docker", RW: true }
  ]);
}
