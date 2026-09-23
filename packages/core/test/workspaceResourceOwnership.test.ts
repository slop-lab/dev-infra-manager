import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import {
  inspectWorkspaceContainer,
  inspectWorkspaceVolume,
  workspaceContainerLabels,
  workspaceVolumeLabels
} from "../../../../core/packages/core/src/workspaceResourceOwnership.js";

const RECORD = {
  name: "work-1",
  projectName: "project",
  projectId: "project-id",
  rootRepositoryAlias: "root",
  runtimeBackend: "sysbox",
  containerName: "dim-ws-work-1",
  dockerVolumeName: "dim-ws-work-1-docker",
  rootSnapshotPath: "/var/lib/dim/project-roots/project-id/approved"
} satisfies Pick<WorkspaceRecord,
  "name" | "projectName" | "projectId" | "rootRepositoryAlias" | "runtimeBackend" |
  "containerName" | "dockerVolumeName" | "rootSnapshotPath">;

const CONTAINER_LABELS = [
  "dim.managed=true",
  "dim.owner=dim",
  "dim.workspace=work-1",
  "dim.project=project",
  "dim.project-id=project-id",
  "dim.repo=root",
  "dim.backend=sysbox",
  "dim.resource=workspace",
  `dim.digest=${identityDigest(["dim-ws-work-1", "work-1", "project", "project-id", "root", "sysbox", "workspace", "container"])}`
] as const;

const VOLUME_LABELS = [
  "dim.managed=true",
  "dim.owner=dim",
  "dim.workspace=work-1",
  "dim.project=project",
  "dim.project-id=project-id",
  "dim.resource=workspace-docker",
  `dim.digest=${identityDigest(["dim-ws-work-1-docker", "work-1", "project", "project-id", "workspace-docker", "volume"])}`
] as const;

class InspectRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];

  constructor(private readonly output: string) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    return { command, args, stdout: `${this.output}\n`, stderr: "", exitCode: 0 };
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}

describe("workspace resource ownership", () => {
  it("builds deterministic complete container and volume labels", () => {
    // Given / When / Then
    expect(workspaceContainerLabels(RECORD)).toEqual(CONTAINER_LABELS);
    expect(workspaceVolumeLabels(RECORD)).toEqual(VOLUME_LABELS);
  });

  it.each(CONTAINER_LABELS.map((_, index) => index))(
    "rejects container ownership when label %s alone differs",
    async (index) => {
      // Given
      const values = CONTAINER_LABELS.map(labelValue);
      values[index] = `foreign-${index}`;
      const runner = new InspectRunner(["container-id", "true", ...values, "7"].join("|"));

      // When / Then
      await expect(inspectWorkspaceContainer(runner, RECORD)).rejects.toThrow(/conflicts with DIM ownership/);
    }
  );

  it("returns the inspected immutable read-only Project-root mount", async () => {
    // Given
    const mounts = [{
      Type: "bind",
      Source: RECORD.rootSnapshotPath,
      Destination: "/run/dim/project-root",
      RW: false
    }];
    const runner = new InspectRunner([
      "container-id", "true", ...CONTAINER_LABELS.map(labelValue), "8", JSON.stringify(mounts)
    ].join("|"));

    // When
    const inspected = await inspectWorkspaceContainer(runner, RECORD);

    // Then
    expect(inspected).toEqual({
      id: "container-id",
      running: true,
      runtimeConfig: "8",
      rootSnapshotPath: RECORD.rootSnapshotPath
    });
  });

  it.each([
    ["missing", []],
    ["writable", [{
      Type: "bind", Source: RECORD.rootSnapshotPath, Destination: "/run/dim/project-root", RW: true
    }]],
    ["volume-backed", [{
      Type: "volume", Source: RECORD.rootSnapshotPath, Destination: "/run/dim/project-root", RW: false
    }]]
  ])("rejects a %s immutable Project-root mount", async (_case, mounts) => {
    // Given
    const runner = new InspectRunner([
      "container-id", "true", ...CONTAINER_LABELS.map(labelValue), "8", JSON.stringify(mounts)
    ].join("|"));

    // When / Then
    await expect(inspectWorkspaceContainer(runner, RECORD)).rejects.toThrow(/Project-root mount/);
  });

  it.each(VOLUME_LABELS.map((_, index) => index))(
    "rejects volume ownership when label %s alone differs",
    async (index) => {
      // Given
      const values = VOLUME_LABELS.map(labelValue);
      values[index] = `foreign-${index}`;
      const runner = new InspectRunner([RECORD.dockerVolumeName, ...values].join("|"));

      // When / Then
      await expect(inspectWorkspaceVolume(runner, RECORD)).rejects.toThrow(/conflicts with DIM ownership/);
    }
  );

  it.each([
    ["missing ID", ["", "true", ...CONTAINER_LABELS.map(labelValue), "7"].join("|")],
    ["partial labels", ["container-id", "true", ...CONTAINER_LABELS.slice(0, -1).map(labelValue), "7"].join("|")]
  ])("rejects malformed container inspection with %s", async (_case, output) => {
    const runner = new InspectRunner(output);
    await expect(inspectWorkspaceContainer(runner, RECORD)).rejects.toThrow(/conflicts with DIM ownership/);
  });
});

function labelValue(label: string): string {
  return label.slice(label.indexOf("=") + 1);
}

function identityDigest(fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of fields) hash.update(`${Buffer.byteLength(field)}:${field};`);
  return hash.digest("hex");
}
