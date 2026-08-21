import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.js";
import { GITEA_NETWORK } from "./gitea.js";
import { giteaCiCoordinator } from "./giteaCiCoordinator.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import { showProject } from "./projectRegistry.js";
import { configuredCiRunnerDefaults } from "./userConfig.js";
import type { CiRunnerExecutorKind, CiRunnerRecord, CiRunnerResources, LifecycleOptions, QemuCiRunnerExecutor, SysboxCiRunnerExecutor } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";
import { QEMU_CI_SUPERVISOR_DOCKERFILE, QEMU_CI_SUPERVISOR_IMAGE, QEMU_CI_SUPERVISOR_SCRIPT, QEMU_CI_WEBHOOK_SCRIPT } from "./qemuCiRunnerAssets.js";

export const BUILTIN_CI_RUNNER_DEFAULTS: CiRunnerResources = { cpus: "4", memory: "8g", pidsLimit: "2048" };
export const CI_RUNNER_LABELS = ["dim:docker://gitea/runner-images:ubuntu-24.04", "ubuntu-24.04:docker://gitea/runner-images:ubuntu-24.04", "dim-container-integration:host"].join(",");

export async function detectCiRunnerKvm(probe: () => Promise<void> = async () => {
  const device = await stat("/dev/kvm");
  if (!device.isCharacterDevice()) throw new Error("/dev/kvm is not a character device");
}, architecture = process.arch): Promise<boolean> {
  if (architecture !== "x64") return false;
  try { await probe(); return true; } catch { return false; }
}

export interface EnableCiRunnerInput { project: string; name: string; executor: CiRunnerExecutorKind; resources?: Partial<CiRunnerResources> }

export function effectiveCiRunnerResources(options: LifecycleOptions, overrides?: Partial<CiRunnerResources>, configured = configuredCiRunnerDefaults()): { resources: CiRunnerResources; inheritsResources: boolean } {
  const defaults = configured ?? { cpus: options.ciRunnerDefaultCpus || BUILTIN_CI_RUNNER_DEFAULTS.cpus, memory: options.ciRunnerDefaultMemory || BUILTIN_CI_RUNNER_DEFAULTS.memory, pidsLimit: options.ciRunnerDefaultPidsLimit || BUILTIN_CI_RUNNER_DEFAULTS.pidsLimit };
  const resources = { cpus: overrides?.cpus ?? defaults.cpus, memory: overrides?.memory ?? defaults.memory, pidsLimit: overrides?.pidsLimit ?? defaults.pidsLimit };
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(resources.cpus) || Number(resources.cpus) <= 0) throw new UserError("CI runner CPUs must be a positive number");
  if (!/^[1-9][0-9]*(?:[kmgt]i?b?|[KMGT]i?B?)?$/.test(resources.memory)) throw new UserError("CI runner memory must be a positive container memory size");
  if (!/^[1-9][0-9]*$/.test(resources.pidsLimit)) throw new UserError("CI runner PID limit must be a positive integer");
  return { resources, inheritsResources: !overrides || Object.values(overrides).every((value) => value === undefined) };
}

export async function enableCiRunner(runner: StreamingCommandRunner, options: LifecycleOptions, input: EnableCiRunnerInput): Promise<CiRunnerRecord> {
  const projectName = validateLifecycleName(input.project, "project");
  const name = validateLifecycleName(input.name, "CI runner");
  if (input.executor === "qemu" && input.resources) throw new UserError("resource overrides apply only to the sysbox CI executor");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireCiRunnerLock(projectName);
  try {
    const project = await showProject(options, projectName);
    if (!project.rootRepositoryAlias) throw new UserError(`project '${projectName}' has no root repository`);
    const existing = await readOptional(state, projectName, name);
    if (existing && existing.executor.kind !== input.executor) {
      throw new UserError(
        `CI runner '${projectName}/${name}' uses executor '${existing.executor.kind}'; disable it before changing executor`
      );
    }
    if (input.executor === "qemu") {
      const other = (await state.listCiRunners()).find((candidate) =>
        candidate.projectName === projectName
          && candidate.name !== name
          && candidate.executor.kind === "qemu");
      if (other) {
        throw new UserError(
          `project '${projectName}' already has QEMU CI runner '${other.name}'; disable it before enabling another`
        );
      }
    }
    const now = new Date().toISOString();
    let record: CiRunnerRecord;
    if (input.executor === "sysbox") {
      const previous = existing?.executor.kind === "sysbox" ? existing.executor : undefined;
      const effective = previous && input.resources === undefined && !previous.inheritsResources ? { resources: previous.resources, inheritsResources: false } : effectiveCiRunnerResources(options, input.resources);
      const executor: SysboxCiRunnerExecutor = { kind: "sysbox", phase: "creating", containerName: ciRunnerContainerName(projectName, name), volumeName: ciRunnerVolumeName(projectName, name), image: options.ciRunnerImage, runtime: options.ciRunnerRuntime, ...effective, labels: ["dim"], updatedAt: now };
      record = await saveExecutor(state, existing ?? newRecord(project, name, executor, now), executor);
      try {
        await removeContainer(runner, executor.containerName);
        await ensureVolume(runner, executor.volumeName);
        if (await registrationExists(runner, executor.volumeName)) {
          await giteaCiCoordinator.removeRunner(runner, options, project, executor.containerName);
          await removeRegistration(runner, executor.volumeName);
        }
        const registration = await giteaCiCoordinator.prepareRunner(runner, options, project);
        const started = await runner.run("docker", ciRunnerContainerArgs(record, executor, registration));
        if (started.exitCode !== 0) throw new UserError(`failed to start sysbox CI runner '${projectName}/${name}': ${started.stderr.trim()}`);
        record = { ...record, provider: registration.provider };
        return saveExecutor(state, record, ready(executor));
      } catch (error) { await saveExecutor(state, record, failed(executor, error)); throw error; }
    }
    if (!await detectCiRunnerKvm()) throw new UserError("the qemu CI executor requires x86-64 and host /dev/kvm access");
    const executor: QemuCiRunnerExecutor = { kind: "qemu", phase: "creating", supervisorName: ciRunnerQemuSupervisorName(projectName, name), volumeName: ciRunnerQemuVolumeName(projectName, name), image: QEMU_CI_SUPERVISOR_IMAGE, labels: ["dim-qemu"], updatedAt: now };
    record = await saveExecutor(state, existing ?? newRecord(project, name, executor, now), executor);
    const webhookName = ciRunnerQemuWebhookName(projectName, name);
    try {
      await giteaCiCoordinator.removeWorkflowJobWebhook(runner, options, project, webhookName);
      await removeContainer(runner, executor.supervisorName);
      await giteaCiCoordinator.removeRunner(runner, options, project, ciRunnerQemuRunnerName(projectName, name));
      await ensureVolume(runner, executor.volumeName);
      const registration = await giteaCiCoordinator.prepareRunner(runner, options, project);
      const authorization = `Bearer ${randomBytes(32).toString("hex")}`;
      await buildQemuSupervisorImage(runner, options.stateRoot);
      const started = await runner.run("docker", ciRunnerQemuSupervisorArgs(record, executor, registration, authorization));
      if (started.exitCode !== 0) throw new UserError(`failed to start QEMU CI runner '${projectName}/${name}': ${started.stderr.trim()}`);
      await giteaCiCoordinator.ensureWorkflowJobWebhook(runner, options, project, { name: webhookName, url: `http://${executor.supervisorName}:8080/workflow-job`, authorizationHeader: authorization });
      record = { ...record, provider: registration.provider };
      return saveExecutor(state, record, ready(executor));
    } catch (error) { await saveExecutor(state, record, failed(executor, error)); throw error; }
  } finally { await release(); }
}

export async function showCiRunner(options: LifecycleOptions, project: string, name: string): Promise<CiRunnerRecord> { return new LifecycleState(options.stateRoot).readCiRunner(validateLifecycleName(project, "project"), validateLifecycleName(name, "CI runner")); }
export async function listCiRunners(options: LifecycleOptions): Promise<CiRunnerRecord[]> { return new LifecycleState(options.stateRoot).listCiRunners(); }

export async function stopCiRunner(runner: StreamingCommandRunner, options: LifecycleOptions, project: string, name: string): Promise<CiRunnerRecord> {
  const state = new LifecycleState(options.stateRoot); project = validateLifecycleName(project, "project"); name = validateLifecycleName(name, "CI runner");
  const release = await state.acquireCiRunnerLock(project);
  try {
    const record = await state.readCiRunner(project, name); const executor = record.executor;
    if (executor.kind === "qemu") await giteaCiCoordinator.removeWorkflowJobWebhook(runner, options, await showProject(options, project), ciRunnerQemuWebhookName(project, name));
    const container = executor.kind === "sysbox" ? executor.containerName : executor.supervisorName;
    const stopped = await runner.run("docker", ["stop", container]);
    if (stopped.exitCode !== 0 && !stopped.stderr.includes("No such container")) throw new UserError(`failed to stop CI runner '${project}/${name}': ${stopped.stderr.trim()}`);
    const updated = await saveExecutor(state, record, { ...executor, phase: "stopped", updatedAt: new Date().toISOString() } as typeof executor);
    if (executor.kind === "qemu") await giteaCiCoordinator.reconcileWorkflowJobWebhookTargets(runner, options);
    return updated;
  } finally { await release(); }
}

export async function disableCiRunner(runner: StreamingCommandRunner, options: LifecycleOptions, project: string, name: string): Promise<void> {
  const state = new LifecycleState(options.stateRoot); project = validateLifecycleName(project, "project"); name = validateLifecycleName(name, "CI runner");
  const release = await state.acquireCiRunnerLock(project);
  try {
    const record = await state.readCiRunner(project, name); const executor = record.executor; const projectRecord = await showProject(options, project);
    if (executor.kind === "sysbox") {
      await removeContainer(runner, executor.containerName); await giteaCiCoordinator.removeRunner(runner, options, projectRecord, executor.containerName); await removeVolume(runner, executor.volumeName, `sysbox CI runner data for '${project}/${name}'`);
    } else {
      await giteaCiCoordinator.removeWorkflowJobWebhook(runner, options, projectRecord, ciRunnerQemuWebhookName(project, name)); await removeContainer(runner, executor.supervisorName); await giteaCiCoordinator.removeRunner(runner, options, projectRecord, ciRunnerQemuRunnerName(project, name)); await removeVolume(runner, executor.volumeName, `QEMU runner data for '${project}/${name}'`);
    }
    await state.removeCiRunner(project, name);
    if (executor.kind === "qemu") await giteaCiCoordinator.reconcileWorkflowJobWebhookTargets(runner, options);
  } finally { await release(); }
}

async function readOptional(state: LifecycleState, project: string, name: string): Promise<CiRunnerRecord | undefined> { try { return await state.readCiRunner(project, name); } catch (error) { if (error instanceof UserError && error.message.includes("not found")) return undefined; throw error; } }
function newRecord(project: { id: string; name: string }, name: string, executor: SysboxCiRunnerExecutor | QemuCiRunnerExecutor, now: string): CiRunnerRecord { return { schemaVersion: 3, name, projectId: project.id, projectName: project.name, provider: "pending", executor, createdAt: now, updatedAt: now }; }
async function saveExecutor(state: LifecycleState, record: CiRunnerRecord, executor: SysboxCiRunnerExecutor | QemuCiRunnerExecutor): Promise<CiRunnerRecord> { const updated = { ...record, executor, updatedAt: new Date().toISOString() }; await state.writeCiRunner(updated); return updated; }
function ready<T extends SysboxCiRunnerExecutor | QemuCiRunnerExecutor>(executor: T): T { const value = { ...executor, phase: "ready", updatedAt: new Date().toISOString() }; delete value.error; return value; }
function failed<T extends SysboxCiRunnerExecutor | QemuCiRunnerExecutor>(executor: T, error: unknown): T { return { ...executor, phase: "error", updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }; }

function runnerResourcePrefix(project: string, name: string): string { return `dim-ci-${validateLifecycleName(project, "project")}-${validateLifecycleName(name, "CI runner")}`; }
export function ciRunnerContainerName(project: string, name: string): string { return runnerResourcePrefix(project, name); }
export function ciRunnerVolumeName(project: string, name: string): string { return `${runnerResourcePrefix(project, name)}-data`; }
export function ciRunnerQemuSupervisorName(project: string, name: string): string { return `${runnerResourcePrefix(project, name)}-qemu-supervisor`; }
export function ciRunnerQemuRunnerName(project: string, name: string): string { return `${runnerResourcePrefix(project, name)}-qemu`; }
export function ciRunnerQemuVolumeName(project: string, name: string): string { return `${runnerResourcePrefix(project, name)}-qemu-data`; }
export function ciRunnerQemuWebhookName(project: string, name: string): string { return `dim-qemu-${validateLifecycleName(project, "project")}-${validateLifecycleName(name, "CI runner")}`; }

export function ciRunnerContainerArgs(record: Pick<CiRunnerRecord, "projectName" | "name">, executor: SysboxCiRunnerExecutor, registration?: { instanceUrl: string; token: string }): string[] {
  return ["run", "--detach", "--name", executor.containerName, "--restart", "unless-stopped", "--network", GITEA_NETWORK, "--runtime", executor.runtime, "--cpus", executor.resources.cpus, "--memory", executor.resources.memory, "--pids-limit", executor.resources.pidsLimit, "--mount", `type=volume,source=${executor.volumeName},target=/data`, "--label", "dim.managed=true", "--label", "dim.resource=ci-runner", "--label", `dim.project=${record.projectName}`, "--label", `dim.ci-runner=${record.name}`, "--env", `GITEA_RUNNER_NAME=${executor.containerName}`, "--env", `GITEA_RUNNER_LABELS=${CI_RUNNER_LABELS}`, ...(registration ? ["--env", `GITEA_INSTANCE_URL=${registration.instanceUrl}`, "--env", `GITEA_RUNNER_REGISTRATION_TOKEN=${registration.token}`] : []), executor.image];
}
export function ciRunnerQemuSupervisorArgs(record: Pick<CiRunnerRecord, "projectName" | "name">, executor: QemuCiRunnerExecutor, registration: { instanceUrl: string; token: string }, authorization: string, kvmGroupId: () => number = () => statSync("/dev/kvm").gid): string[] {
  return ["run", "--detach", "--name", executor.supervisorName, "--restart", "unless-stopped", "--network", GITEA_NETWORK, "--runtime", "runc", "--cpus", "6", "--memory", "14g", "--pids-limit", "1024", "--device", "/dev/kvm", "--group-add", String(kvmGroupId()), "--mount", `type=volume,source=${executor.volumeName},target=/var/lib/dim-qemu-ci`, "--label", "dim.managed=true", "--label", "dim.resource=ci-qemu-supervisor", "--label", `dim.project=${record.projectName}`, "--label", `dim.ci-runner=${record.name}`, "--env", `GITEA_INSTANCE_URL=${registration.instanceUrl}`, "--env", `GITEA_RUNNER_REGISTRATION_TOKEN=${registration.token}`, "--env", `GITEA_RUNNER_NAME=${ciRunnerQemuRunnerName(record.projectName, record.name)}`, "--env", `DIM_QEMU_WEBHOOK_AUTHORIZATION=${authorization}`, executor.image];
}

async function buildQemuSupervisorImage(runner: StreamingCommandRunner, stateRoot: string): Promise<void> { const context = path.join(stateRoot, "assets", "qemu-ci-supervisor"); await mkdir(context, { recursive: true, mode: 0o700 }); await writeFile(path.join(context, "Dockerfile"), QEMU_CI_SUPERVISOR_DOCKERFILE, { mode: 0o600 }); await writeFile(path.join(context, "supervise.bash"), QEMU_CI_SUPERVISOR_SCRIPT, { mode: 0o600 }); await writeFile(path.join(context, "webhook.py"), QEMU_CI_WEBHOOK_SCRIPT, { mode: 0o600 }); const result = await runner.run("docker", ["build", "--tag", QEMU_CI_SUPERVISOR_IMAGE, context]); if (result.exitCode !== 0) throw new UserError(`failed to build QEMU runner supervisor: ${result.stderr.trim()}`); }
async function removeContainer(runner: StreamingCommandRunner, name: string): Promise<void> { const result = await runner.run("docker", ["container", "rm", "--force", name]); if (result.exitCode !== 0 && !result.stderr.includes("No such container")) throw new UserError(`failed to replace CI runner container '${name}': ${result.stderr.trim()}`); }
async function ensureVolume(runner: StreamingCommandRunner, name: string): Promise<void> { if ((await runner.run("docker", ["volume", "inspect", name])).exitCode === 0) return; const result = await runner.run("docker", ["volume", "create", "--label", "dim.managed=true", "--label", "dim.resource=ci-runner-data", name]); if (result.exitCode !== 0) throw new UserError(`failed to create CI runner data volume: ${result.stderr.trim()}`); }
async function removeVolume(runner: StreamingCommandRunner, name: string, description: string): Promise<void> { const result = await runner.run("docker", ["volume", "rm", name]); if (result.exitCode !== 0 && !result.stderr.includes("No such volume")) throw new UserError(`failed to remove ${description}: ${result.stderr.trim()}`); }
async function registrationExists(runner: StreamingCommandRunner, volume: string): Promise<boolean> { return (await runner.run("docker", ["run", "--rm", "--mount", `type=volume,source=${volume},target=/data`, "--entrypoint", "sh", "alpine:3.22", "-c", "test -s /data/.runner"])).exitCode === 0; }
async function removeRegistration(runner: StreamingCommandRunner, volume: string): Promise<void> { const result = await runner.run("docker", ["run", "--rm", "--mount", `type=volume,source=${volume},target=/data`, "--entrypoint", "sh", "alpine:3.22", "-c", "rm -f /data/.runner"]); if (result.exitCode !== 0) throw new UserError(`failed to reset CI runner registration: ${result.stderr.trim()}`); }
