import { UserError } from "./errors.js";
import { ciRunnerContainerLabels, ciRunnerContainerPlan } from "./ciRunnerContainer.js";
import { validateLifecycleName } from "./lifecycleState.js";
import type { CiRunnerRecord, QemuCiRunnerExecutor } from "./lifecycleTypes.js";
import { boundedCiRunnerResourceName } from "./ciRunnerVolume.js";
import type { CiRunnerVolumePlan } from "./ciRunnerVolume.js";
import {
  ciRunnerQemuCommonCacheVolumeName,
  QEMU_CI_COMMON_MOUNT,
  QEMU_CI_NO_HOOK_DIGEST,
  QEMU_CI_PROJECT_CACHE_MOUNT,
  QEMU_CI_PROJECT_MOUNT
} from "./qemuCiRunnerImage.js";
import type { PreparedQemuProjectHook } from "./qemuCiRunnerImage.js";
import { CONTROL_NETWORK, REGISTRY_CACHE_ENDPOINT } from "./registryCache.js";

export interface QemuCiRunnerSupervisorLaunchPlan {
  readonly record: Pick<CiRunnerRecord, "projectName" | "projectId" | "name">;
  readonly executor: QemuCiRunnerExecutor;
  readonly registration: { readonly instanceUrl: string; readonly token: string };
  readonly authorization: string;
  readonly kvmGroupId: () => number;
  readonly commonImageKey: string;
  readonly projectImageKey: string;
  readonly projectHook: PreparedQemuProjectHook;
}

export interface QemuCiRunnerVolumeDeletionPlan {
  readonly project: string;
  readonly projectId: string;
  readonly capacityName: string;
  readonly remainingCapacityNames: readonly string[];
}

export function ciRunnerQemuProjectCacheVolumeName(project: string): string {
  return boundedCiRunnerResourceName(["dim", "ci", validateLifecycleName(project, "project"), "qemu", "cache"]);
}

export function ciRunnerQemuSupervisorName(project: string, capacity: string): string {
  return resourceName(project, capacity, ["qemu", "supervisor"]);
}

export function ciRunnerQemuRunnerName(project: string, capacity: string): string {
  return resourceName(project, capacity, ["qemu"]);
}

export function ciRunnerQemuVolumeName(project: string, capacity: string): string {
  return resourceName(project, capacity, ["qemu", "data"]);
}

export function ciRunnerQemuDispatchVolumeName(project: string): string {
  return boundedCiRunnerResourceName(["dim", "ci", validateLifecycleName(project, "project"), "qemu", "dispatch"]);
}

export function ciRunnerQemuSupervisorLaunchArgs(plan: QemuCiRunnerSupervisorLaunchPlan): string[] {
  if (!/^sha256:[0-9a-f]{64}$/.test(plan.executor.image)) {
    throw new UserError("QEMU CI supervisor image must be a complete Docker image ID");
  }
  assertDigest(plan.commonImageKey, "QEMU common image key");
  assertDigest(plan.projectImageKey, "QEMU Project image key");
  assertDigest(plan.projectHook.digest, "QEMU Project hook digest");
  assertImage(plan.executor.jobImage);
  assertLabels(plan.executor.labels);
  if (plan.projectHook.kind === "absent" && plan.projectHook.digest !== QEMU_CI_NO_HOOK_DIGEST) {
    throw new UserError("absent QEMU Project hook must use the no-hook digest");
  }
  const recordedHook = plan.executor.projectHook;
  if (recordedHook.sourceRef !== plan.projectHook.sourceRef
    || recordedHook.sourceCommit !== plan.projectHook.sourceCommit
    || recordedHook.kind !== plan.projectHook.kind
    || recordedHook.digest !== plan.projectHook.digest) {
    throw new UserError("QEMU Project hook artifact does not match runner state provenance");
  }
  const project = validateLifecycleName(plan.record.projectName, "project");
  const capacity = validateLifecycleName(plan.record.name, "CI runner");
  const guestMemoryMiB = qemuMemoryMiB(plan.executor.resources.memory);
  const ownershipLabels = ciRunnerContainerLabels(ciRunnerContainerPlan(plan.record, plan.executor));
  return [
    "run", "--detach", "--name", plan.executor.supervisorName, "--restart", "unless-stopped",
    "--network", CONTROL_NETWORK, "--runtime", "runc", "--cpus", plan.executor.resources.cpus,
    "--memory", `${guestMemoryMiB + 2048}m`, "--pids-limit", "1024", "--device", "/dev/kvm",
    "--group-add", String(plan.kvmGroupId()),
    "--mount", `type=volume,source=${plan.executor.volumeName},target=/var/lib/dim-qemu-ci`,
    "--mount", `type=volume,source=${ciRunnerQemuDispatchVolumeName(project)},target=/var/lib/dim-qemu-ci-dispatch`,
    "--mount", `type=volume,source=${ciRunnerQemuCommonCacheVolumeName()},target=${QEMU_CI_COMMON_MOUNT}`,
    "--mount", `type=volume,source=${ciRunnerQemuProjectCacheVolumeName(project)},target=${QEMU_CI_PROJECT_CACHE_MOUNT}`,
    "--mount", `type=bind,source=${plan.projectHook.path},target=${QEMU_CI_PROJECT_MOUNT}/cache.bash,readonly`,
    ...ownershipLabels.flatMap((label) => ["--label", label]),
    "--env", `GITEA_INSTANCE_URL=${plan.registration.instanceUrl}`,
    "--env", `GITEA_RUNNER_REGISTRATION_TOKEN=${plan.registration.token}`,
    "--env", `GITEA_RUNNER_NAME=${ciRunnerQemuRunnerName(project, capacity)}`,
    "--env", `DIM_CI_REGISTRY_CACHE_UPSTREAM=${REGISTRY_CACHE_ENDPOINT}`,
    "--env", `DIM_QEMU_CI_COMMON_IMAGE_KEY=${plan.commonImageKey}`,
    "--env", `DIM_QEMU_CI_PROJECT_IMAGE_KEY=${plan.projectImageKey}`,
    "--env", `DIM_QEMU_CI_PROJECT_HOOK_KIND=${plan.projectHook.kind}`,
    "--env", `DIM_QEMU_CI_PROJECT_HOOK_DIGEST=${plan.projectHook.digest}`,
    "--env", `DIM_QEMU_CI_PROJECT_HOOK_SOURCE_REF=${plan.projectHook.sourceRef}`,
    "--env", `DIM_QEMU_CI_PROJECT_HOOK_SOURCE_COMMIT=${plan.projectHook.sourceCommit}`,
    "--env", `DIM_QEMU_CI_JOB_IMAGE=${plan.executor.jobImage}`,
    "--env", `DIM_QEMU_CI_LABELS=${plan.executor.labels.join(",")}`,
    "--env", `DIM_QEMU_CI_CAPACITY=${capacity}`,
    "--env", `DIM_QEMU_CI_CPUS=${plan.executor.resources.cpus}`,
    "--env", `DIM_QEMU_CI_MEMORY_MB=${guestMemoryMiB}`,
    "--env", `DIM_QEMU_WEBHOOK_AUTHORIZATION=${plan.authorization}`,
    plan.executor.image
  ];
}

export function ciRunnerQemuVolumeDeletionNames(plan: QemuCiRunnerVolumeDeletionPlan): readonly string[] {
  return ciRunnerQemuVolumeDeletionPlans(plan).map((volume) => volume.name);
}

export function ciRunnerQemuVolumeDeletionPlans(
  plan: QemuCiRunnerVolumeDeletionPlan
): readonly CiRunnerVolumePlan[] {
  const project = validateLifecycleName(plan.project, "project");
  const scope = { project, projectId: plan.projectId };
  const capacityVolume = {
    ...scope,
    name: ciRunnerQemuVolumeName(project, plan.capacityName),
    resource: "ci-qemu-data"
  } satisfies CiRunnerVolumePlan;
  for (const capacity of plan.remainingCapacityNames) validateLifecycleName(capacity, "CI runner");
  if (plan.remainingCapacityNames.length !== 0) return [capacityVolume];
  return [
    capacityVolume,
    { ...scope, name: ciRunnerQemuDispatchVolumeName(project), resource: "ci-qemu-dispatch" },
    { ...scope, name: ciRunnerQemuProjectCacheVolumeName(project), resource: "ci-qemu-project-cache" }
  ];
}

export function qemuMemoryMiB(memory: string): number {
  const match = /^([1-9][0-9]*)([kmgt]?)(?:i?b?)?$/i.exec(memory);
  if (!match) throw new UserError("QEMU CI runner memory must be a positive memory size");
  const value = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit === "t" ? 1024 * 1024 : unit === "g" ? 1024 : unit === "m" ? 1 : unit === "k" ? 1 / 1024 : 1 / (1024 * 1024);
  return Math.ceil(value * multiplier);
}

function resourceName(project: string, capacity: string, suffix: readonly string[]): string {
  return boundedCiRunnerResourceName([
    "dim", "ci",
    validateLifecycleName(project, "project"),
    validateLifecycleName(capacity, "CI runner"),
    ...suffix
  ]);
}

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new UserError(`${label} must be a complete lowercase SHA-256 digest`);
}

function assertImage(value: string): void {
  if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/.test(value)) {
    throw new UserError("QEMU CI job image must be digest-pinned without a tag");
  }
}

function assertLabels(labels: readonly string[]): void {
  if (!labels.includes("dim-qemu")) throw new UserError("QEMU CI labels must include dim-qemu");
  if (new Set(labels).size !== labels.length || labels.some((label) => !/^[a-z0-9][a-z0-9._-]*$/.test(label))) {
    throw new UserError("QEMU CI labels must be unique safe runner labels");
  }
}
