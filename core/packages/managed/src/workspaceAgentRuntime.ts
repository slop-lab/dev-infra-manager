import { createHash } from "node:crypto";
import type { WorkspaceRecord } from "./lifecycleTypes.js";
import {
  allocateWorkspaceResourceBudget,
  workspaceResourceBudgetLabels
} from "./workspaceResourceBudget.js";

export type WorkspaceAgentIdentity = {
  readonly containerName: string;
  readonly networkName: string;
  readonly homeVolumeName: string;
  readonly checkoutVolumeName: string;
  readonly dockerVolumeName: string;
};

export type WorkspaceAgentVolumeResource = "agent-home" | "agent-checkout" | "agent-docker";

export function workspaceAgentIdentity(record: Pick<WorkspaceRecord, "name">): WorkspaceAgentIdentity {
  return {
    containerName: `dim-agent-${record.name}`,
    networkName: `dim-agent-${record.name}`,
    homeVolumeName: `dim-agent-${record.name}-home`,
    checkoutVolumeName: `dim-agent-${record.name}-checkout`,
    dockerVolumeName: `dim-agent-${record.name}-docker`
  };
}

export function workspaceAgentVolumeLabels(
  record: Pick<WorkspaceRecord, "name" | "workspaceId" | "projectName" | "projectId">,
  resource: WorkspaceAgentVolumeResource
): readonly string[] {
  return labels(record, resource, [record.workspaceId, record.projectId, resource]);
}

export function workspaceAgentContainerLabels(
  record: Pick<WorkspaceRecord, "name" | "workspaceId" | "projectName" | "projectId">
): readonly string[] {
  return labels(record, "agent", [record.workspaceId, record.projectId, "agent"]);
}

export function workspaceAgentNetworkLabels(
  record: Pick<WorkspaceRecord, "name" | "workspaceId" | "projectName" | "projectId">
): readonly string[] {
  return labels(record, "agent-network", [record.workspaceId, record.projectId, "agent-network"]);
}

export function workspaceAgentContainerArgs(record: WorkspaceRecord, image: string): string[] {
  const identity = workspaceAgentIdentity(record);
  const resources = allocateWorkspaceResourceBudget("recommended", record).agent;
  return [
    "run", "--detach",
    "--name", identity.containerName,
    "--network", identity.networkName,
    "--runtime", "sysbox-runc",
    "--cpus", resources.cpuCount,
    "--memory", resources.memory,
    "--memory-swap", resources.memory,
    "--pids-limit", resources.pidsLimit,
    "--mount", `type=volume,source=${identity.homeVolumeName},target=/home/dim`,
    "--mount", `type=volume,source=${identity.checkoutVolumeName},target=/workspace`,
    "--mount", `type=volume,source=${identity.dockerVolumeName},target=/var/lib/docker`,
    ...workspaceAgentContainerLabels(record).flatMap((label) => ["--label", label]),
    ...workspaceResourceBudgetLabels("agent").flatMap((label) => ["--label", label]),
    "--env", `DIM_GIT_USER_NAME=${record.gitUserName}`,
    "--env", `DIM_GIT_USER_EMAIL=${record.gitUserEmail}`,
    "--entrypoint", "/usr/local/bin/dim-agent-entrypoint",
    image,
    "sleep", "infinity"
  ];
}

function labels(
  record: Pick<WorkspaceRecord, "name" | "workspaceId" | "projectName" | "projectId">,
  resource: string,
  digestFields: readonly string[]
): readonly string[] {
  return [
    "dim.managed=true",
    "dim.owner=dim",
    `dim.workspace=${record.name}`,
    `dim.workspace-id=${record.workspaceId}`,
    `dim.project=${record.projectName}`,
    `dim.project-id=${record.projectId}`,
    `dim.resource=${resource}`,
    `dim.digest=${identityDigest(digestFields)}`
  ];
}

function identityDigest(fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of fields) hash.update(`${Buffer.byteLength(field)}:${field};`);
  return hash.digest("hex");
}
