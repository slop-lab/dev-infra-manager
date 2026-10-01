import { createHash } from "node:crypto";
import { ciRunnerResourceIdentityDigest } from "./ciRunnerResourceIdentity.js";
import { UserError } from "./errors.js";
import { validateLifecycleName } from "./lifecycleState.js";
import type { StreamingCommandRunner } from "./types.js";

export type CiRunnerVolumeResource =
  | "ci-runner-data"
  | "ci-qemu-data"
  | "ci-qemu-dispatch"
  | "ci-qemu-common-cache"
  | "ci-qemu-project-cache";

type HostVolumeScope = {
  readonly project?: never;
  readonly projectId?: never;
};

type ProjectVolumeScope = {
  readonly project: string;
  readonly projectId: string;
};

export type CiRunnerVolumePlan = {
  readonly name: string;
  readonly resource: CiRunnerVolumeResource;
} & (HostVolumeScope | ProjectVolumeScope);

const VOLUME_LABEL_FORMAT = [
  "{{index .Labels \"dim.managed\"}}",
  "{{index .Labels \"dim.owner\"}}",
  "{{index .Labels \"dim.project\"}}",
  "{{index .Labels \"dim.project-id\"}}",
  "{{index .Labels \"dim.resource\"}}",
  "{{index .Labels \"dim.kind\"}}",
  "{{index .Labels \"dim.digest\"}}"
].join("|");

export function boundedCiRunnerResourceName(parts: readonly string[]): string {
  const name = parts.join("-");
  const digest = identityDigest(parts).slice(0, 16);
  const prefix = name.slice(0, 46).replace(/[._-]+$/, "");
  return `${prefix}-${digest}`;
}

export function ciRunnerVolumeLabels(plan: CiRunnerVolumePlan): readonly string[] {
  const scope = volumeScope(plan);
  const digest = ciRunnerResourceIdentityDigest(
    [plan.name, scope.project, scope.projectId, plan.resource],
    "volume"
  );
  return [
    "dim.managed=true",
    "dim.owner=dim",
    `dim.project=${scope.project}`,
    `dim.project-id=${scope.projectId}`,
    `dim.resource=${plan.resource}`,
    "dim.kind=volume",
    `dim.digest=${digest}`
  ];
}

export async function ensureCiRunnerVolume(
  runner: StreamingCommandRunner,
  plan: CiRunnerVolumePlan
): Promise<void> {
  const inspected = await inspectCiRunnerVolume(runner, plan);
  if (inspected === "owned") return;
  const labels = ciRunnerVolumeLabels(plan);
  const created = await runner.run("docker", [
    "volume", "create",
    ...labels.flatMap((label) => ["--label", label]),
    plan.name
  ]);
  if (await inspectCiRunnerVolume(runner, plan) === "owned") return;
  const detail = created.stderr.trim();
  throw new UserError(created.exitCode === 0
    ? `failed to verify created CI runner volume '${plan.name}'`
    : `failed to create CI runner volume '${plan.name}': ${detail}`);
}

export async function removeCiRunnerVolume(
  runner: StreamingCommandRunner,
  plan: CiRunnerVolumePlan,
  description: string
): Promise<void> {
  if (await inspectCiRunnerVolume(runner, plan) === "absent") return;
  if (await inspectCiRunnerVolume(runner, plan) === "absent") return;
  const removed = await runner.run("docker", ["volume", "rm", plan.name]);
  if (removed.exitCode !== 0 && !isMissingVolume(removed.stderr)) {
    throw new UserError(`failed to remove ${description}: ${removed.stderr.trim()}`);
  }
}

async function inspectCiRunnerVolume(
  runner: StreamingCommandRunner,
  plan: CiRunnerVolumePlan
): Promise<"absent" | "owned"> {
  const inspected = await runner.run("docker", [
    "volume", "inspect", plan.name, "--format", VOLUME_LABEL_FORMAT
  ]);
  if (inspected.exitCode !== 0) {
    if (isMissingVolume(inspected.stderr)) return "absent";
    throw new UserError(`failed to inspect CI runner volume '${plan.name}': ${inspected.stderr.trim()}`);
  }
  const expected = ciRunnerVolumeLabels(plan).map((label) => label.slice(label.indexOf("=") + 1)).join("|");
  if (inspected.stdout.trim() !== expected) {
    throw new UserError(`Docker volume '${plan.name}' conflicts with DIM ownership`);
  }
  return "owned";
}

function volumeScope(plan: CiRunnerVolumePlan): { readonly project: string; readonly projectId: string } {
  if (plan.project === undefined) return { project: "host", projectId: "host" };
  const project = validateLifecycleName(plan.project, "project");
  if (!/^[A-Za-z0-9-]+$/.test(plan.projectId)) throw new UserError(`project ID '${plan.projectId}' is invalid`);
  return { project, projectId: plan.projectId };
}

function identityDigest(fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of fields) hash.update(`${Buffer.byteLength(field)}:${field};`);
  return hash.digest("hex");
}

function isMissingVolume(stderr: string): boolean {
  return /no such volume/i.test(stderr);
}
