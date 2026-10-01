import { createHash } from "node:crypto";
import { UserError } from "./errors.js";
import type { WorkspaceRecord } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";
import { PROJECT_ROOT } from "./workspaceLifecycleTypes.js";

type WorkspaceIdentity = Pick<WorkspaceRecord,
  "name" | "workspaceId" | "projectName" | "projectId" | "rootRepositoryAlias" | "runtimeBackend" |
  "containerName" | "dockerVolumeName">;

const CONTAINER_LABEL_KEYS = [
  "dim.managed",
  "dim.owner",
  "dim.workspace",
  "dim.workspace-id",
  "dim.project",
  "dim.project-id",
  "dim.repo",
  "dim.backend",
  "dim.resource",
  "dim.digest"
] as const;

const CONTAINER_INSPECT_FORMAT = [
  "{{.Id}}",
  "{{.State.Running}}",
  ...CONTAINER_LABEL_KEYS.map((key) => `{{index .Config.Labels "${key}"}}`),
  "{{index .Config.Labels \"dim.runtime-config\"}}",
  "{{json .Mounts}}"
].join("|");

const VOLUME_LABEL_KEYS = [
  "dim.managed",
  "dim.owner",
  "dim.workspace",
  "dim.project",
  "dim.project-id",
  "dim.resource",
  "dim.digest"
] as const;

const VOLUME_INSPECT_FORMAT = [
  "{{.Name}}",
  ...VOLUME_LABEL_KEYS.map((key) => `{{index .Labels "${key}"}}`)
].join("|");

export type InspectedWorkspaceContainer = {
  readonly id: string;
  readonly running: boolean;
  readonly runtimeConfig: string;
  readonly rootSnapshotPath: string;
};

export function workspaceContainerLabels(record: WorkspaceIdentity): readonly string[] {
  const fields = [
    record.containerName,
    record.name,
    record.workspaceId,
    record.projectName,
    record.projectId,
    record.rootRepositoryAlias,
    record.runtimeBackend,
    "workspace",
    "container"
  ];
  return [
    "dim.managed=true",
    "dim.owner=dim",
    `dim.workspace=${record.name}`,
    `dim.workspace-id=${record.workspaceId}`,
    `dim.project=${record.projectName}`,
    `dim.project-id=${record.projectId}`,
    `dim.repo=${record.rootRepositoryAlias}`,
    `dim.backend=${record.runtimeBackend}`,
    "dim.resource=workspace",
    `dim.digest=${identityDigest(fields)}`
  ];
}

export function workspaceVolumeLabels(record: WorkspaceIdentity): readonly string[] {
  const fields = [
    record.dockerVolumeName,
    record.name,
    record.projectName,
    record.projectId,
    "workspace-docker",
    "volume"
  ];
  return [
    "dim.managed=true",
    "dim.owner=dim",
    `dim.workspace=${record.name}`,
    `dim.project=${record.projectName}`,
    `dim.project-id=${record.projectId}`,
    "dim.resource=workspace-docker",
    `dim.digest=${identityDigest(fields)}`
  ];
}

export async function inspectWorkspaceContainer(
  runner: StreamingCommandRunner,
  record: WorkspaceIdentity
): Promise<InspectedWorkspaceContainer | undefined> {
  const inspected = await runner.run("docker", [
    "container", "inspect", record.containerName, "--format", CONTAINER_INSPECT_FORMAT
  ]);
  if (inspected.exitCode !== 0) {
    if (isMissingContainer(inspected.stderr, record.containerName)) return undefined;
    throw new UserError(`failed to inspect workspace container '${record.containerName}': ${inspected.stderr.trim()}`);
  }
  const [id, running, ...values] = inspected.stdout.trim().split("|");
  const labels = values.slice(0, CONTAINER_LABEL_KEYS.length);
  const runtimeConfig = values[CONTAINER_LABEL_KEYS.length];
  const expected = workspaceContainerLabels(record).map(labelValue).join("|");
  if (!id || (running !== "true" && running !== "false") || labels.join("|") !== expected || runtimeConfig === undefined) {
    throw new UserError(`Docker container '${record.containerName}' conflicts with DIM ownership`);
  }
  const rootSnapshotPath = parseProjectRootMount(
    values.slice(CONTAINER_LABEL_KEYS.length + 1).join("|"),
    record.containerName
  );
  return { id, running: running === "true", runtimeConfig, rootSnapshotPath };
}

export async function inspectWorkspaceVolume(
  runner: StreamingCommandRunner,
  record: WorkspaceIdentity
): Promise<string | undefined> {
  const inspected = await runner.run("docker", [
    "volume", "inspect", record.dockerVolumeName, "--format", VOLUME_INSPECT_FORMAT
  ]);
  if (inspected.exitCode !== 0) {
    if (isMissingVolume(inspected.stderr, record.dockerVolumeName)) return undefined;
    throw new UserError(`failed to inspect workspace Docker volume '${record.dockerVolumeName}': ${inspected.stderr.trim()}`);
  }
  const [name, ...labels] = inspected.stdout.trim().split("|");
  const expected = workspaceVolumeLabels(record).map(labelValue).join("|");
  if (!name || name !== record.dockerVolumeName || labels.join("|") !== expected) {
    throw new UserError(`Docker volume '${record.dockerVolumeName}' conflicts with DIM ownership`);
  }
  return name;
}

export function isMissingContainer(stderr: string, target: string): boolean {
  const diagnostic = stderr.trim();
  return diagnostic === `Error: No such container: ${target}`
    || diagnostic === `Error: No such object: ${target}`
    || diagnostic === `Error response from daemon: No such container: ${target}`
    || diagnostic === `Error response from daemon: No such object: ${target}`;
}

export function isMissingVolume(stderr: string, target: string): boolean {
  const diagnostic = stderr.trim();
  return diagnostic === `Error: No such volume: ${target}`
    || diagnostic === `Error response from daemon: No such volume: ${target}`
    || diagnostic === `Error response from daemon: get ${target}: no such volume`;
}

function labelValue(label: string): string {
  return label.slice(label.indexOf("=") + 1);
}

type DockerMount = {
  readonly Type: string;
  readonly Source: string;
  readonly Destination: string;
  readonly RW: boolean;
};

function parseProjectRootMount(raw: string, containerName: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UserError(`Docker container '${containerName}' has an invalid immutable Project-root mount`);
  }
  const mounts = Array.isArray(parsed) ? parsed.filter(isDockerMount) : [];
  const projectRoots = mounts.filter((mount) => mount.Destination === PROJECT_ROOT);
  if (projectRoots.length !== 1) {
    throw new UserError(`Docker container '${containerName}' has an invalid immutable Project-root mount`);
  }
  const mount = projectRoots[0];
  if (mount === undefined || mount.Type !== "bind" || mount.RW || mount.Source.length === 0) {
    throw new UserError(`Docker container '${containerName}' has an invalid immutable Project-root mount`);
  }
  return mount.Source;
}

function isDockerMount(value: unknown): value is DockerMount {
  return typeof value === "object" && value !== null
    && "Type" in value && typeof value.Type === "string"
    && "Source" in value && typeof value.Source === "string"
    && "Destination" in value && typeof value.Destination === "string"
    && "RW" in value && typeof value.RW === "boolean";
}

function identityDigest(fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of fields) hash.update(`${Buffer.byteLength(field)}:${field};`);
  return hash.digest("hex");
}
