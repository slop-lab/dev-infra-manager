import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import {
  workspaceContainerLabels,
  workspaceVolumeLabels
} from "../../../../core/packages/core/src/workspaceResourceOwnership.js";

type WorkspaceIdentity = Pick<WorkspaceRecord,
  "name" | "projectName" | "projectId" | "rootRepositoryAlias" | "runtimeBackend" |
  "containerName" | "dockerVolumeName">;

export function workspaceContainerInspect(
  record: WorkspaceIdentity,
  input: {
    readonly id?: string;
    readonly running?: boolean;
    readonly runtimeConfig?: string;
  } = {}
): string {
  return [
    input.id ?? "workspace-container-id",
    String(input.running ?? true),
    ...workspaceContainerLabels(record).map(labelValue),
    input.runtimeConfig ?? "7"
  ].join("|");
}

export function workspaceVolumeInspect(record: WorkspaceIdentity): string {
  return [record.dockerVolumeName, ...workspaceVolumeLabels(record).map(labelValue)].join("|");
}

function labelValue(label: string): string {
  return label.slice(label.indexOf("=") + 1);
}
