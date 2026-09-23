import { statSync } from "node:fs";
import path from "node:path";
import { UserError } from "./errors.js";
import { LifecycleState } from "./lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import {
  DOCKER_HUB_DIRECT_HOSTNAMES,
  ensureRegistryCache,
  REGISTRY_CACHE_ENDPOINT
} from "./registryCache.js";
import { workspaceRuntimePlan } from "./runtimeBackends.js";
import type { StreamingCommandRunner } from "./types.js";
import {
  PROJECT_ROOT,
  WORKSPACE_RUNTIME_CONFIG_VERSION,
  WORKSPACE_USER,
  type WorkspaceGitEnvironment
} from "./workspaceLifecycleTypes.js";
import { assertRootSnapshot } from "./workspaceProjectCommands.js";
import { probeKvmDevice } from "./workspaceValidation.js";
import {
  inspectWorkspaceContainer,
  inspectWorkspaceVolume,
  isMissingContainer,
  workspaceContainerLabels,
  workspaceVolumeLabels
} from "./workspaceResourceOwnership.js";

export async function assertContainerRunning(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord
): Promise<string> {
  const container = await inspectWorkspaceContainer(runner, record);
  if (container === undefined || !container.running) {
    throw new UserError(`workspace '${record.name}' is stopped; run dim workspace start`);
  }
  if (container.rootSnapshotPath !== record.rootSnapshotPath) {
    throw new UserError(`workspace '${record.name}' container root does not match its recorded immutable root`);
  }
  return container.id;
}

export async function reconcileContainer(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  record: WorkspaceRecord,
  git: WorkspaceGitEnvironment
): Promise<string> {
  await assertRootSnapshot(record);
  if (record.kvm) {
    try {
      await probeKvmDevice();
    } catch {
      throw new UserError(`workspace '${record.name}' requires host /dev/kvm`);
    }
  }
  await ensureRegistryCache(runner, options.stateRoot);
  await reconcileDockerVolume(runner, record);
  const state = new LifecycleState(options.stateRoot);
  const controllerGrant = await state.ensureWorkspaceGrant(record.name);
  const agentGrant = await state.ensureAgentGrant(record.name);
  let container = await inspectWorkspaceContainer(runner, record);
  if (container === undefined) {
    const created = await runner.run("docker", workspaceContainerArgs(
      options, record, git, controllerGrant, undefined, agentGrant
    ));
    container = await inspectWorkspaceContainer(runner, record);
    if (container === undefined) {
      throw new UserError(created.exitCode === 0
        ? "failed to verify created workspace container"
        : `failed to create workspace container: ${created.stderr.trim()}`);
    }
  }
  if (container.runtimeConfig !== WORKSPACE_RUNTIME_CONFIG_VERSION
    || container.rootSnapshotPath !== record.rootSnapshotPath) {
    const removed = await runner.run("docker", ["container", "rm", "--force", container.id]);
    if (removed.exitCode !== 0 && !isMissingContainer(removed.stderr, container.id)) {
      throw new UserError(`failed to replace workspace container: ${removed.stderr.trim()}`);
    }
    const created = await runner.run("docker", workspaceContainerArgs(
      options, record, git, controllerGrant, undefined, agentGrant
    ));
    container = await inspectWorkspaceContainer(runner, record);
    if (container === undefined) {
      throw new UserError(created.exitCode === 0
        ? "failed to verify created workspace container"
        : `failed to create workspace container: ${created.stderr.trim()}`);
    }
    if (container.runtimeConfig !== WORKSPACE_RUNTIME_CONFIG_VERSION) {
      throw new UserError(`workspace container '${record.containerName}' has stale runtime configuration`);
    }
    if (container.rootSnapshotPath !== record.rootSnapshotPath) {
      throw new UserError(`workspace container '${record.containerName}' has the wrong immutable Project root`);
    }
  }
  if (!container.running) {
    const started = await runner.run("docker", ["start", container.id]);
    if (started.exitCode !== 0) throw new UserError(`failed to start workspace '${record.name}'`);
  }
  await waitForWorkspaceRuntime(
    runner,
    container.id,
    workspaceRuntimePlan(record.runtimeBackend, options).engine
  );
  return container.id;
}

async function reconcileDockerVolume(runner: StreamingCommandRunner, record: WorkspaceRecord): Promise<void> {
  if (await inspectWorkspaceVolume(runner, record) === undefined) {
    const labels = workspaceVolumeLabels(record);
    const created = await runner.run("docker", [
      "volume", "create",
      ...labels.flatMap((label) => ["--label", label]),
      record.dockerVolumeName
    ]);
    if (await inspectWorkspaceVolume(runner, record) === undefined) {
      throw new UserError(created.exitCode === 0
        ? "failed to verify created workspace Docker volume"
        : `failed to create workspace Docker volume: ${created.stderr.trim()}`);
    }
  }
}

export function workspaceContainerArgs(
  options: LifecycleOptions,
  record: WorkspaceRecord,
  git: WorkspaceGitEnvironment,
  controllerGrant?: string,
  kvmGroupId: () => number = () => statSync("/dev/kvm").gid,
  agentGrant?: string
): string[] {
  const plan = workspaceRuntimePlan(record.runtimeBackend, options);
  const args = [
    "run", "--detach",
    "--name", record.containerName,
    "--network", record.networkName,
    "--add-host", "host.docker.internal:host-gateway",
    ...DOCKER_HUB_DIRECT_HOSTNAMES.map((hostname) => `--add-host=${hostname}:127.0.0.1`),
    "--runtime", plan.dockerRuntime,
    "--cpus", record.cpuCount,
    "--memory", record.memory,
    "--memory-swap", record.memory,
    "--pids-limit", record.pidsLimit,
    "--mount", `type=volume,source=${record.dockerVolumeName},target=${plan.runtimeDataPath}`,
    "--mount", `type=bind,source=${record.rootSnapshotPath},target=${PROJECT_ROOT},readonly`,
    "--mount", `type=bind,source=${path.dirname(options.controllerSocketPath)},target=/run/dim/controller`,
    "--mount", `type=bind,source=${path.dirname(options.agentControllerSocketPath)},target=/run/dim/agent-controller`,
    ...workspaceContainerLabels(record).flatMap((label) => ["--label", label]),
    "--label", `dim.runtime-config=${WORKSPACE_RUNTIME_CONFIG_VERSION}`,
    "--env", `DIM_GIT_USERNAME=${git.username}`,
    "--env", `DIM_GIT_TOKEN=${git.token}`,
    "--env", `DIM_GIT_USER_NAME=${git.userName}`,
    "--env", `DIM_GIT_USER_EMAIL=${git.userEmail}`,
    "--env", "DIM_CONTROLLER_SOCKET=/run/dim/controller/controller.sock",
    "--env", "GIT_ASKPASS=/usr/local/bin/dim-git-askpass",
    "--env", "GIT_TERMINAL_PROMPT=0",
    "--env", "GIT_CONFIG_COUNT=2",
    "--env", "GIT_CONFIG_KEY_0=user.name",
    "--env", `GIT_CONFIG_VALUE_0=${git.userName}`,
    "--env", "GIT_CONFIG_KEY_1=user.email",
    "--env", `GIT_CONFIG_VALUE_1=${git.userEmail}`,
    "--env", `DIM_REGISTRY_CACHE_ENDPOINT=${REGISTRY_CACHE_ENDPOINT}`
  ];
  for (const [hostname, addresses] of Object.entries(record.hostAliases)) {
    for (const address of addresses) args.push("--add-host", `${hostname}:${address}`);
  }
  if (controllerGrant) args.push("--env", `DIM_CONTROLLER_TOKEN=${controllerGrant}`);
  if (agentGrant) {
    args.push("--env", "DIM_AGENT_CONTROLLER_SOCKET=/run/dim/agent-controller/controller.sock");
    args.push("--env", `DIM_AGENT_CONTROLLER_TOKEN=${agentGrant}`);
  }
  for (const capability of plan.capabilities) args.push("--cap-add", capability);
  for (const provision of record.capabilities ?? []) {
    if (provision.status !== "provided") continue;
    for (const capability of provision.capabilities ?? []) args.push("--cap-add", capability);
    for (const securityOption of provision.securityOptions ?? []) args.push("--security-opt", securityOption);
    for (const device of provision.devices ?? []) args.push("--device", device);
    for (const [key, value] of Object.entries(provision.environment ?? {})) args.push("--env", `${key}=${value}`);
  }
  for (const securityOption of plan.securityOptions) args.push("--security-opt", securityOption);
  for (const device of plan.devices) args.push("--device", device);
  if (record.kvm) {
    args.push("--device", "/dev/kvm");
    args.push("--group-add", String(kvmGroupId()));
  }
  for (const [key, value] of Object.entries(plan.env)) args.push("--env", `${key}=${value}`);
  if (plan.privileged) args.push("--privileged");
  args.push(plan.image, "sleep", "infinity");
  return args;
}

export async function waitForInnerDocker(runner: StreamingCommandRunner, containerName: string): Promise<void> {
  return waitForWorkspaceRuntime(runner, containerName, "docker");
}

export async function waitForWorkspaceRuntime(
  runner: StreamingCommandRunner,
  containerName: string,
  engine: "docker"
): Promise<void> {
  let lastError = "not ready";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await runner.run("docker", ["exec", "--user", WORKSPACE_USER, containerName, engine, "info"]);
    if (result.exitCode === 0) return;
    lastError = result.stderr.trim() || result.stdout.trim();
    const inspect = await runner.run("docker", ["inspect", "--format", "{{json .State}}", containerName]);
    if (inspect.exitCode === 0) {
      try {
        const state = JSON.parse(inspect.stdout) as { Running?: boolean; Status?: string };
        if (state.Running === false || state.Status === "exited" || state.Status === "dead") break;
      } catch {
        // Preserve the original readiness error and retry when state output is malformed.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const state = await runner.run("docker", [
    "inspect", "--format",
    "status={{.State.Status}} exitCode={{.State.ExitCode}} oomKilled={{.State.OOMKilled}} error={{json .State.Error}}",
    containerName
  ]);
  const logs = await runner.run("docker", ["logs", containerName]);
  const details = [
    `nested ${engine} did not become ready: ${lastError}`,
    state.exitCode === 0 ? `workspace container: ${state.stdout.trim()}` : `workspace container inspect failed: ${state.stderr.trim() || state.stdout.trim()}`,
    `workspace container logs:\n${logs.stdout || logs.stderr || "(empty)"}`
  ];
  throw new UserError(details.join("\n"));
}
