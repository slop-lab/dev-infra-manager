import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import {
  workspaceContainerLabels,
  workspaceVolumeLabels
} from "../../../../core/packages/core/src/workspaceResourceOwnership.js";

type WorkspaceIdentity = Pick<WorkspaceRecord,
  "name" | "workspaceId" | "projectName" | "projectId" | "rootRepositoryAlias" | "runtimeBackend" |
  "containerName" | "dockerVolumeName"> & { readonly rootSnapshotPath?: string };

export function workspaceContainerInspect(
  record: WorkspaceIdentity,
  input: {
    readonly id?: string;
    readonly running?: boolean;
    readonly runtimeConfig?: string;
    readonly rootSnapshotPath?: string;
  } = {}
): string {
  return [
    input.id ?? "workspace-container-id",
    String(input.running ?? true),
    ...workspaceContainerLabels(record).map(labelValue),
    input.runtimeConfig ?? "9",
    JSON.stringify([{
      Type: "bind",
      Source: input.rootSnapshotPath ?? record.rootSnapshotPath ?? "/var/lib/dim/project-roots/default",
      Destination: "/run/dim/project-root",
      RW: false
    }])
  ].join("|");
}

export function workspaceVolumeInspect(record: WorkspaceIdentity): string {
  return [record.dockerVolumeName, ...workspaceVolumeLabels(record).map(labelValue)].join("|");
}

function labelValue(label: string): string {
  return label.slice(label.indexOf("=") + 1);
}
