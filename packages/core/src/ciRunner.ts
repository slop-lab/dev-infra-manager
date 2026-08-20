import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { UserError } from "./errors.js";
import { GITEA_NETWORK } from "./gitea.js";
import { giteaCiCoordinator } from "./giteaCiCoordinator.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import { showProject } from "./projectRegistry.js";
import { configuredCiRunnerDefaults } from "./userConfig.js";
import type { CiRunnerRecord, CiRunnerResources, LifecycleOptions } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";

export const BUILTIN_CI_RUNNER_DEFAULTS: CiRunnerResources = {
  cpus: "4",
  memory: "8g",
  pidsLimit: "2048"
};

export const CI_RUNNER_LABELS = [
  "dim:docker://gitea/runner-images:ubuntu-24.04",
  "ubuntu-24.04:docker://gitea/runner-images:ubuntu-24.04",
  "dim-container-integration:host"
].join(",");

export function ciRunnerLabels(kvm: boolean): string {
  return [CI_RUNNER_LABELS, ...(kvm ? ["dim-release-gate:host"] : [])].join(",");
}

export async function detectCiRunnerKvm(probe: () => Promise<void> = async () => {
  const device = await stat("/dev/kvm");
  if (!device.isCharacterDevice()) throw new Error("/dev/kvm is not a character device");
}): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}

export interface EnableCiRunnerInput {
  project: string;
  resources?: Partial<CiRunnerResources>;
}

export function effectiveCiRunnerResources(
  options: LifecycleOptions,
  overrides?: Partial<CiRunnerResources>,
  configured = configuredCiRunnerDefaults()
): { resources: CiRunnerResources; inheritsResources: boolean } {
  const defaults = configured ?? {
    cpus: options.ciRunnerDefaultCpus || BUILTIN_CI_RUNNER_DEFAULTS.cpus,
    memory: options.ciRunnerDefaultMemory || BUILTIN_CI_RUNNER_DEFAULTS.memory,
    pidsLimit: options.ciRunnerDefaultPidsLimit || BUILTIN_CI_RUNNER_DEFAULTS.pidsLimit
  };
  const resources = {
      cpus: overrides?.cpus ?? defaults.cpus,
      memory: overrides?.memory ?? defaults.memory,
      pidsLimit: overrides?.pidsLimit ?? defaults.pidsLimit
  };
  validateResources(resources);
  return {
    resources,
    inheritsResources: overrides === undefined
      || (overrides.cpus === undefined && overrides.memory === undefined && overrides.pidsLimit === undefined)
  };
}

function validateResources(resources: CiRunnerResources): void {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(resources.cpus) || Number(resources.cpus) <= 0) {
    throw new UserError("CI runner CPUs must be a positive number");
  }
  if (!/^[1-9][0-9]*(?:[kmgt]i?b?|[KMGT]i?B?)?$/.test(resources.memory)) {
    throw new UserError("CI runner memory must be a positive container memory size");
  }
  if (!/^[1-9][0-9]*$/.test(resources.pidsLimit)) {
    throw new UserError("CI runner PID limit must be a positive integer");
  }
}

export async function enableCiRunner(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  input: EnableCiRunnerInput
): Promise<CiRunnerRecord> {
  const projectName = validateLifecycleName(input.project, "project");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireCiRunnerLock(projectName);
  try {
    const project = await showProject(options, projectName);
    if (!project.rootRepositoryAlias) throw new UserError(`project '${projectName}' has no root repository`);
    const now = new Date().toISOString();
    let existing: CiRunnerRecord | undefined;
    try { existing = await state.readCiRunner(projectName); } catch (error) {
      if (!(error instanceof UserError) || !error.message.includes("not found")) throw error;
    }
    const effective = existing && input.resources === undefined && !existing.inheritsResources
      ? { resources: existing.resources, inheritsResources: false }
      : effectiveCiRunnerResources(options, input.resources);
    const kvm = await detectCiRunnerKvm();
    let record: CiRunnerRecord = {
      schemaVersion: 1,
      name: projectName,
      projectId: project.id,
      projectName,
      provider: existing?.provider ?? "pending",
      backend: "container",
      phase: "creating",
      containerName: ciRunnerContainerName(projectName),
      volumeName: ciRunnerVolumeName(projectName),
      image: options.ciRunnerImage,
      runtime: options.ciRunnerRuntime,
      kvm,
      resources: effective.resources,
      inheritsResources: effective.inheritsResources,
      labels: ["dim", ...(kvm ? ["dim-release-gate"] : [])],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await state.writeCiRunner(record);
    try {
      await removeContainer(runner, record.containerName);
      await ensureVolume(runner, record.volumeName);
      if (await registrationExists(runner, record.volumeName)) {
        await giteaCiCoordinator.removeRunner(runner, options, project, record.containerName);
        await removeRegistration(runner, record.volumeName);
      }
      const registration = await giteaCiCoordinator.prepareRunner(runner, options, project);
      if (registration) record = { ...record, provider: registration.provider };
      await startContainer(runner, record, registration);
      record = { ...record, phase: "ready", updatedAt: new Date().toISOString() };
      delete record.error;
      await state.writeCiRunner(record);
      return record;
    } catch (error) {
      record = {
        ...record,
        phase: "error",
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
      await state.writeCiRunner(record);
      throw error;
    }
  } finally {
    await release();
  }
}

export async function showCiRunner(options: LifecycleOptions, project: string): Promise<CiRunnerRecord> {
  return new LifecycleState(options.stateRoot).readCiRunner(validateLifecycleName(project, "project"));
}

export async function listCiRunners(options: LifecycleOptions): Promise<CiRunnerRecord[]> {
  return new LifecycleState(options.stateRoot).listCiRunners();
}

export async function stopCiRunner(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  project: string
): Promise<CiRunnerRecord> {
  const state = new LifecycleState(options.stateRoot);
  const record = await state.readCiRunner(validateLifecycleName(project, "project"));
  const stopped = await runner.run("docker", ["stop", record.containerName]);
  if (stopped.exitCode !== 0 && !stopped.stderr.includes("No such container")) {
    throw new UserError(`failed to stop CI runner '${project}': ${stopped.stderr.trim()}`);
  }
  const updated = { ...record, phase: "stopped" as const, updatedAt: new Date().toISOString() };
  await state.writeCiRunner(updated);
  return updated;
}

export async function disableCiRunner(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  project: string
): Promise<void> {
  const state = new LifecycleState(options.stateRoot);
  const name = validateLifecycleName(project, "project");
  const record = await state.readCiRunner(name);
  await removeContainer(runner, record.containerName);
  const projectRecord = await showProject(options, name);
  await giteaCiCoordinator.removeRunner(runner, options, projectRecord, record.containerName);
  const removed = await runner.run("docker", ["volume", "rm", record.volumeName]);
  if (removed.exitCode !== 0 && !removed.stderr.includes("No such volume")) {
    throw new UserError(`failed to remove CI runner data for '${name}': ${removed.stderr.trim()}`);
  }
  await state.removeCiRunner(name);
}

export function ciRunnerContainerName(project: string): string {
  return `dim-ci-${validateLifecycleName(project, "project")}`;
}

export function ciRunnerVolumeName(project: string): string {
  return `dim-ci-${validateLifecycleName(project, "project")}-data`;
}

async function startContainer(
  runner: StreamingCommandRunner,
  record: CiRunnerRecord,
  registration?: { instanceUrl: string; token: string }
): Promise<void> {
  const result = await runner.run("docker", ciRunnerContainerArgs(record, registration));
  if (result.exitCode !== 0) throw new UserError(`failed to start CI runner '${record.projectName}': ${result.stderr.trim()}`);
}

export function ciRunnerContainerArgs(
  record: CiRunnerRecord,
  registration?: { instanceUrl: string; token: string },
  kvmGroupId: () => number = () => statSync("/dev/kvm").gid
): string[] {
  return [
    "run", "--detach",
    "--name", record.containerName,
    "--restart", "unless-stopped",
    "--network", GITEA_NETWORK,
    "--runtime", record.runtime,
    "--cpus", record.resources.cpus,
    "--memory", record.resources.memory,
    "--pids-limit", record.resources.pidsLimit,
    "--mount", `type=volume,source=${record.volumeName},target=/data`,
    "--label", "dim.managed=true",
    "--label", "dim.resource=ci-runner",
    "--label", `dim.project=${record.projectName}`,
    "--env", `GITEA_RUNNER_NAME=${record.containerName}`,
    "--env", `GITEA_RUNNER_LABELS=${ciRunnerLabels(record.kvm)}`,
    ...(registration ? [
      "--env", `GITEA_INSTANCE_URL=${registration.instanceUrl}`,
      "--env", `GITEA_RUNNER_REGISTRATION_TOKEN=${registration.token}`
    ] : []),
    ...(record.kvm ? ["--device", "/dev/kvm", "--group-add", String(kvmGroupId())] : []),
    record.image
  ];
}

async function removeContainer(runner: StreamingCommandRunner, name: string): Promise<void> {
  const result = await runner.run("docker", ["container", "rm", "--force", name]);
  if (result.exitCode !== 0 && !result.stderr.includes("No such container")) {
    throw new UserError(`failed to replace CI runner container '${name}': ${result.stderr.trim()}`);
  }
}

async function ensureVolume(runner: StreamingCommandRunner, name: string): Promise<void> {
  const inspected = await runner.run("docker", ["volume", "inspect", name]);
  if (inspected.exitCode === 0) return;
  const created = await runner.run("docker", [
    "volume", "create",
    "--label", "dim.managed=true",
    "--label", "dim.resource=ci-runner-data",
    name
  ]);
  if (created.exitCode !== 0) throw new UserError(`failed to create CI runner data volume: ${created.stderr.trim()}`);
}

async function registrationExists(runner: StreamingCommandRunner, volume: string): Promise<boolean> {
  const result = await runner.run("docker", [
    "run", "--rm",
    "--mount", `type=volume,source=${volume},target=/data`,
    "--entrypoint", "sh",
    "alpine:3.22",
    "-c", "test -s /data/.runner"
  ]);
  return result.exitCode === 0;
}

async function removeRegistration(runner: StreamingCommandRunner, volume: string): Promise<void> {
  const result = await runner.run("docker", [
    "run", "--rm",
    "--mount", `type=volume,source=${volume},target=/data`,
    "--entrypoint", "sh",
    "alpine:3.22",
    "-c", "rm -f /data/.runner"
  ]);
  if (result.exitCode !== 0) {
    throw new UserError(`failed to reset CI runner registration: ${result.stderr.trim()}`);
  }
}
