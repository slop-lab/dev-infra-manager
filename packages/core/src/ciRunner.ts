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

export interface EnableCiRunnerInput { project: string; executor: CiRunnerExecutorKind; resources?: Partial<CiRunnerResources> }

export function effectiveCiRunnerResources(options: LifecycleOptions, overrides?: Partial<CiRunnerResources>, configured = configuredCiRunnerDefaults()): { resources: CiRunnerResources; inheritsResources: boolean } {
  const defaults = configured ?? { cpus: options.ciRunnerDefaultCpus || BUILTIN_CI_RUNNER_DEFAULTS.cpus, memory: options.ciRunnerDefaultMemory || BUILTIN_CI_RUNNER_DEFAULTS.memory, pidsLimit: options.ciRunnerDefaultPidsLimit || BUILTIN_CI_RUNNER_DEFAULTS.pidsLimit };
  const resources = { cpus: overrides?.cpus ?? defaults.cpus, memory: overrides?.memory ?? defaults.memory, pidsLimit: overrides?.pidsLimit ?? defaults.pidsLimit };
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(resources.cpus) || Number(resources.cpus) <= 0) throw new UserError("CI runner CPUs must be a positive number");
  if (!/^[1-9][0-9]*(?:[kmgt]i?b?|[KMGT]i?B?)?$/.test(resources.memory)) throw new UserError("CI runner memory must be a positive container memory size");
  if (!/^[1-9][0-9]*$/.test(resources.pidsLimit)) throw new UserError("CI runner PID limit must be a positive integer");
  return { resources, inheritsResources: !overrides || Object.values(overrides).every((value) => value === undefined) };
}

export async function enableCiRunner(runner: StreamingCommandRunner, options: LifecycleOptions, input: EnableCiRunnerInput): Promise<CiRunnerRecord> {
  const name = validateLifecycleName(input.project, "project");
  if (input.executor === "qemu" && input.resources) throw new UserError("resource overrides apply only to the sysbox CI executor");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireCiRunnerLock(name);
  try {
    const project = await showProject(options, name);
    if (!project.rootRepositoryAlias) throw new UserError(`project '${name}' has no root repository`);
    const existing = await readOptional(state, name);
    const now = new Date().toISOString();
    let record: CiRunnerRecord = existing ?? { schemaVersion: 2, name, projectId: project.id, projectName: name, provider: "pending", executors: {}, createdAt: now, updatedAt: now };
    if (input.executor === "sysbox") {
      const previous = record.executors.sysbox;
      const effective = previous && input.resources === undefined && !previous.inheritsResources ? { resources: previous.resources, inheritsResources: false } : effectiveCiRunnerResources(options, input.resources);
      const executor: SysboxCiRunnerExecutor = { kind: "sysbox", phase: "creating", containerName: ciRunnerContainerName(name), volumeName: ciRunnerVolumeName(name), image: options.ciRunnerImage, runtime: options.ciRunnerRuntime, ...effective, labels: ["dim"], updatedAt: now };
      record = await saveExecutor(state, record, "sysbox", executor);
      try {
        await removeContainer(runner, executor.containerName);
        await ensureVolume(runner, executor.volumeName);
        if (await registrationExists(runner, executor.volumeName)) {
          await giteaCiCoordinator.removeRunner(runner, options, project, executor.containerName);
          await removeRegistration(runner, executor.volumeName);
        }
        const registration = await giteaCiCoordinator.prepareRunner(runner, options, project);
        const started = await runner.run("docker", ciRunnerContainerArgs(record, executor, registration));
        if (started.exitCode !== 0) throw new UserError(`failed to start sysbox CI executor '${name}': ${started.stderr.trim()}`);
        record = { ...record, provider: registration.provider };
        return saveExecutor(state, record, "sysbox", ready(executor));
      } catch (error) { await saveExecutor(state, record, "sysbox", failed(executor, error)); throw error; }
    }
    if (!await detectCiRunnerKvm()) throw new UserError("the qemu CI executor requires x86-64 and host /dev/kvm access");
    const executor: QemuCiRunnerExecutor = { kind: "qemu", phase: "creating", supervisorName: ciRunnerQemuSupervisorName(name), volumeName: ciRunnerQemuVolumeName(name), image: QEMU_CI_SUPERVISOR_IMAGE, labels: ["dim-qemu"], updatedAt: now };
    record = await saveExecutor(state, record, "qemu", executor);
    const webhookName = ciRunnerQemuWebhookName(name);
    try {
      await giteaCiCoordinator.removeWorkflowJobWebhook(runner, options, project, webhookName);
      await removeContainer(runner, executor.supervisorName);
      await giteaCiCoordinator.removeRunner(runner, options, project, ciRunnerQemuRunnerName(name));
      await ensureVolume(runner, executor.volumeName);
      const registration = await giteaCiCoordinator.prepareRunner(runner, options, project);
      const authorization = `Bearer ${randomBytes(32).toString("hex")}`;
      await buildQemuSupervisorImage(runner, options.stateRoot);
      const started = await runner.run("docker", ciRunnerQemuSupervisorArgs(record, executor, registration, authorization));
      if (started.exitCode !== 0) throw new UserError(`failed to start QEMU CI executor '${name}': ${started.stderr.trim()}`);
      await giteaCiCoordinator.ensureWorkflowJobWebhook(runner, options, project, { name: webhookName, url: `http://${executor.supervisorName}:8080/workflow-job`, authorizationHeader: authorization });
      record = { ...record, provider: registration.provider };
      return saveExecutor(state, record, "qemu", ready(executor));
    } catch (error) { await saveExecutor(state, record, "qemu", failed(executor, error)); throw error; }
  } finally { await release(); }
}

export async function showCiRunner(options: LifecycleOptions, project: string): Promise<CiRunnerRecord> { return new LifecycleState(options.stateRoot).readCiRunner(validateLifecycleName(project, "project")); }
export async function listCiRunners(options: LifecycleOptions): Promise<CiRunnerRecord[]> { return new LifecycleState(options.stateRoot).listCiRunners(); }

export async function stopCiRunner(runner: StreamingCommandRunner, options: LifecycleOptions, project: string, kind: CiRunnerExecutorKind): Promise<CiRunnerRecord> {
  const state = new LifecycleState(options.stateRoot); const name = validateLifecycleName(project, "project"); const record = await state.readCiRunner(name); const executor = requiredExecutor(record, kind);
  if (kind === "qemu") await giteaCiCoordinator.removeWorkflowJobWebhook(runner, options, await showProject(options, name), ciRunnerQemuWebhookName(name));
  const container = kind === "sysbox" ? (executor as SysboxCiRunnerExecutor).containerName : (executor as QemuCiRunnerExecutor).supervisorName;
  const stopped = await runner.run("docker", ["stop", container]);
  if (stopped.exitCode !== 0 && !stopped.stderr.includes("No such container")) throw new UserError(`failed to stop ${kind} CI executor '${name}': ${stopped.stderr.trim()}`);
  return saveExecutor(state, record, kind, { ...executor, phase: "stopped", updatedAt: new Date().toISOString() } as never);
}

export async function disableCiRunner(runner: StreamingCommandRunner, options: LifecycleOptions, project: string, kind: CiRunnerExecutorKind): Promise<void> {
  const state = new LifecycleState(options.stateRoot); const name = validateLifecycleName(project, "project"); const record = await state.readCiRunner(name); const executor = requiredExecutor(record, kind); const projectRecord = await showProject(options, name);
  if (kind === "sysbox") {
    const value = executor as SysboxCiRunnerExecutor; await removeContainer(runner, value.containerName); await giteaCiCoordinator.removeRunner(runner, options, projectRecord, value.containerName); await removeVolume(runner, value.volumeName, `sysbox CI runner data for '${name}'`);
  } else {
    const value = executor as QemuCiRunnerExecutor; await giteaCiCoordinator.removeWorkflowJobWebhook(runner, options, projectRecord, ciRunnerQemuWebhookName(name)); await removeContainer(runner, value.supervisorName); await giteaCiCoordinator.removeRunner(runner, options, projectRecord, ciRunnerQemuRunnerName(name)); await removeVolume(runner, value.volumeName, `QEMU runner data for '${name}'`);
  }
  const executors = { ...record.executors }; delete executors[kind];
  if (Object.keys(executors).length === 0) await state.removeCiRunner(name); else await state.writeCiRunner({ ...record, executors, updatedAt: new Date().toISOString() });
}

function requiredExecutor(record: CiRunnerRecord, kind: CiRunnerExecutorKind): SysboxCiRunnerExecutor | QemuCiRunnerExecutor { const value = record.executors[kind]; if (!value) throw new UserError(`project '${record.projectName}' has no ${kind} CI executor`); return value; }
async function readOptional(state: LifecycleState, name: string): Promise<CiRunnerRecord | undefined> { try { return await state.readCiRunner(name); } catch (error) { if (error instanceof UserError && error.message.includes("not found")) return undefined; throw error; } }
async function saveExecutor(state: LifecycleState, record: CiRunnerRecord, kind: CiRunnerExecutorKind, executor: SysboxCiRunnerExecutor | QemuCiRunnerExecutor): Promise<CiRunnerRecord> { const updated = { ...record, executors: { ...record.executors, [kind]: executor }, updatedAt: new Date().toISOString() }; await state.writeCiRunner(updated); return updated; }
function ready<T extends SysboxCiRunnerExecutor | QemuCiRunnerExecutor>(executor: T): T { const value = { ...executor, phase: "ready", updatedAt: new Date().toISOString() }; delete value.error; return value; }
function failed<T extends SysboxCiRunnerExecutor | QemuCiRunnerExecutor>(executor: T, error: unknown): T { return { ...executor, phase: "error", updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }; }

export function ciRunnerContainerName(project: string): string { return `dim-ci-${validateLifecycleName(project, "project")}`; }
export function ciRunnerVolumeName(project: string): string { return `dim-ci-${validateLifecycleName(project, "project")}-data`; }
export function ciRunnerQemuSupervisorName(project: string): string { return `dim-ci-${validateLifecycleName(project, "project")}-qemu-supervisor`; }
export function ciRunnerQemuRunnerName(project: string): string { return `dim-ci-${validateLifecycleName(project, "project")}-qemu`; }
export function ciRunnerQemuVolumeName(project: string): string { return `dim-ci-${validateLifecycleName(project, "project")}-qemu-data`; }
export function ciRunnerQemuWebhookName(project: string): string { return `dim-qemu-${validateLifecycleName(project, "project")}`; }

export function ciRunnerContainerArgs(record: Pick<CiRunnerRecord, "projectName">, executor: SysboxCiRunnerExecutor, registration?: { instanceUrl: string; token: string }): string[] {
  return ["run", "--detach", "--name", executor.containerName, "--restart", "unless-stopped", "--network", GITEA_NETWORK, "--runtime", executor.runtime, "--cpus", executor.resources.cpus, "--memory", executor.resources.memory, "--pids-limit", executor.resources.pidsLimit, "--mount", `type=volume,source=${executor.volumeName},target=/data`, "--label", "dim.managed=true", "--label", "dim.resource=ci-runner", "--label", `dim.project=${record.projectName}`, "--env", `GITEA_RUNNER_NAME=${executor.containerName}`, "--env", `GITEA_RUNNER_LABELS=${CI_RUNNER_LABELS}`, ...(registration ? ["--env", `GITEA_INSTANCE_URL=${registration.instanceUrl}`, "--env", `GITEA_RUNNER_REGISTRATION_TOKEN=${registration.token}`] : []), executor.image];
}
export function ciRunnerQemuSupervisorArgs(record: Pick<CiRunnerRecord, "projectName">, executor: QemuCiRunnerExecutor, registration: { instanceUrl: string; token: string }, authorization: string, kvmGroupId: () => number = () => statSync("/dev/kvm").gid): string[] {
  return ["run", "--detach", "--name", executor.supervisorName, "--restart", "unless-stopped", "--network", GITEA_NETWORK, "--runtime", "runc", "--cpus", "6", "--memory", "14g", "--pids-limit", "1024", "--device", "/dev/kvm", "--group-add", String(kvmGroupId()), "--mount", `type=volume,source=${executor.volumeName},target=/var/lib/dim-qemu-ci`, "--label", "dim.managed=true", "--label", "dim.resource=ci-qemu-supervisor", "--label", `dim.project=${record.projectName}`, "--env", `GITEA_INSTANCE_URL=${registration.instanceUrl}`, "--env", `GITEA_RUNNER_REGISTRATION_TOKEN=${registration.token}`, "--env", `GITEA_RUNNER_NAME=${ciRunnerQemuRunnerName(record.projectName)}`, "--env", `DIM_QEMU_WEBHOOK_AUTHORIZATION=${authorization}`, executor.image];
}

async function buildQemuSupervisorImage(runner: StreamingCommandRunner, stateRoot: string): Promise<void> { const context = path.join(stateRoot, "assets", "qemu-ci-supervisor"); await mkdir(context, { recursive: true, mode: 0o700 }); await writeFile(path.join(context, "Dockerfile"), QEMU_CI_SUPERVISOR_DOCKERFILE, { mode: 0o600 }); await writeFile(path.join(context, "supervise.bash"), QEMU_CI_SUPERVISOR_SCRIPT, { mode: 0o600 }); await writeFile(path.join(context, "webhook.py"), QEMU_CI_WEBHOOK_SCRIPT, { mode: 0o600 }); const result = await runner.run("docker", ["build", "--tag", QEMU_CI_SUPERVISOR_IMAGE, context]); if (result.exitCode !== 0) throw new UserError(`failed to build QEMU runner supervisor: ${result.stderr.trim()}`); }
async function removeContainer(runner: StreamingCommandRunner, name: string): Promise<void> { const result = await runner.run("docker", ["container", "rm", "--force", name]); if (result.exitCode !== 0 && !result.stderr.includes("No such container")) throw new UserError(`failed to replace CI runner container '${name}': ${result.stderr.trim()}`); }
async function ensureVolume(runner: StreamingCommandRunner, name: string): Promise<void> { if ((await runner.run("docker", ["volume", "inspect", name])).exitCode === 0) return; const result = await runner.run("docker", ["volume", "create", "--label", "dim.managed=true", "--label", "dim.resource=ci-runner-data", name]); if (result.exitCode !== 0) throw new UserError(`failed to create CI runner data volume: ${result.stderr.trim()}`); }
async function removeVolume(runner: StreamingCommandRunner, name: string, description: string): Promise<void> { const result = await runner.run("docker", ["volume", "rm", name]); if (result.exitCode !== 0 && !result.stderr.includes("No such volume")) throw new UserError(`failed to remove ${description}: ${result.stderr.trim()}`); }
async function registrationExists(runner: StreamingCommandRunner, volume: string): Promise<boolean> { return (await runner.run("docker", ["run", "--rm", "--mount", `type=volume,source=${volume},target=/data`, "--entrypoint", "sh", "alpine:3.22", "-c", "test -s /data/.runner"])).exitCode === 0; }
async function removeRegistration(runner: StreamingCommandRunner, volume: string): Promise<void> { const result = await runner.run("docker", ["run", "--rm", "--mount", `type=volume,source=${volume},target=/data`, "--entrypoint", "sh", "alpine:3.22", "-c", "rm -f /data/.runner"]); if (result.exitCode !== 0) throw new UserError(`failed to reset CI runner registration: ${result.stderr.trim()}`); }
