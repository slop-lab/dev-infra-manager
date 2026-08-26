import path from "node:path";
import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { UserError } from "./errors.js";
import { ensureGitea, giteaNestedBaseUrl, GITEA_NETWORK } from "./gitea.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import { applyProjectRepositoryProtection, normalizeRepositoryRef } from "./projectRegistry.js";
import type {
  GiteaCredentials,
  LifecycleOptions,
  ProjectRecord,
  ProjectRepositoryRecord,
  WorkspaceCapabilityRecord,
  WorkspaceRecord
} from "./lifecycleTypes.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import { workspaceRuntimePlan } from "./runtimeBackends.js";
import type { StreamingCommandRunner } from "./types.js";
import { inspectProjectRuntimeCgroups, type ProjectRuntimeCgroups } from "./projectRuntimeCgroups.js";
import {
  ensureRegistryCache,
  REGISTRY_CACHE_CONTAINER,
  REGISTRY_CACHE_ENDPOINT
} from "./registryCache.js";

// The unprivileged OS user every workspace image (core/images/project-workspace,
// core/images/project-workspace-podman) creates and runs project commands as.
const WORKSPACE_USER = "dim";
const WORKSPACE_RUNTIME_CONFIG_VERSION = "4";

export interface WorkspaceGitEnvironment {
  username: string;
  token: string;
  userName: string;
  userEmail: string;
}

export interface WorkspaceCommandInput {
  name: string;
  command: string[];
  interactive: boolean;
}

export interface WorkspaceResourceInput {
  cpuCount?: string;
  memory?: string;
  pidsLimit?: string;
}

export function validateWorkspaceResources(resources: {
  cpuCount: string;
  memory: string;
  pidsLimit: string;
}): void {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(resources.cpuCount) || Number(resources.cpuCount) <= 0) {
    throw new UserError("workspace CPU limit must be a positive number");
  }
  if (!/^[1-9][0-9]*(?:[kmgt]i?b?|[KMGT]i?B?)?$/.test(resources.memory)) {
    throw new UserError("workspace memory limit must be a positive container memory size");
  }
  if (!/^[1-9][0-9]*$/.test(resources.pidsLimit)) {
    throw new UserError("workspace PID limit must be a positive integer");
  }
}

export function validateWorkspaceProfiles(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value) || value.includes(",")) {
      throw new UserError(`workspace profile '${value}' must match [a-z0-9][a-z0-9_.-]{0,63}`);
    }
    if (seen.has(value)) throw new UserError(`workspace profile '${value}' is duplicated`);
    seen.add(value);
  }
  return [...seen];
}

export async function resolveWorkspaceCapabilities(
  required: string[],
  recommended: string[],
  project: ProjectRecord,
  workspaceName: string,
  runtimeBackend: WorkspaceRecord["runtimeBackend"],
  providers: RegisteredDimPlugins["workspaceCapabilityProviders"]
): Promise<WorkspaceCapabilityRecord[]> {
  const requests = [...required.map((name) => ({ name, requirement: "required" as const })),
    ...recommended.map((name) => ({ name, requirement: "recommended" as const }))];
  const seen = new Set<string>();
  const resolved: WorkspaceCapabilityRecord[] = [];
  for (const request of requests) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(request.name)) {
      throw new UserError(`workspace capability '${request.name}' has an invalid name`);
    }
    if (seen.has(request.name)) throw new UserError(`workspace capability '${request.name}' is duplicated`);
    seen.add(request.name);
    const registered = providers.get(request.name);
    if (!registered) {
      if (request.requirement === "required") {
        throw new UserError(`required workspace capability '${request.name}' has no installed provider`);
      }
      resolved.push({ ...request, status: "unavailable", detail: "no installed provider" });
      continue;
    }
    try {
      const provision = await registered.provider.provision({
        projectId: project.id, projectName: project.name, workspaceName, runtimeBackend
      });
      const capabilities = [...(provision.capabilities ?? [])];
      const securityOptions = [...(provision.securityOptions ?? [])];
      const devices = [...(provision.devices ?? [])];
      const environment = { ...(provision.environment ?? {}) };
      if (capabilities.some((value) => !/^[A-Z][A-Z0-9_]*$/.test(value))) {
        throw new UserError("provider returned an invalid Linux capability");
      }
      if (securityOptions.some((value) => value.length === 0 || value.includes("\0"))) {
        throw new UserError("provider returned an invalid security option");
      }
      if (devices.some((value) => !value.startsWith("/") || value.includes("\0"))) {
        throw new UserError("provider returned an invalid device path");
      }
      if (Object.entries(environment).some(([key, value]) =>
        !/^[A-Z_][A-Z0-9_]*$/.test(key) || value.includes("\0"))) {
        throw new UserError("provider returned an invalid environment entry");
      }
      resolved.push({ ...request, status: "provided", plugin: registered.plugin,
        ...(provision.detail ? { detail: provision.detail } : {}),
        ...(capabilities.length ? { capabilities } : {}),
        ...(securityOptions.length ? { securityOptions } : {}),
        ...(devices.length ? { devices } : {}),
        ...(Object.keys(environment).length ? { environment } : {}) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (request.requirement === "required") {
        throw new UserError(`required workspace capability '${request.name}' could not be provided: ${detail}`);
      }
      resolved.push({ ...request, status: "unavailable", plugin: registered.plugin, detail });
    }
  }
  return resolved;
}

export function validateRepositoryRefOverrides(
  values: string[],
  project: ProjectRecord
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new UserError(`repository ref override '${value}' must use alias=ref`);
    }
    const alias = validateLifecycleName(value.slice(0, separator), "repo alias");
    if (!project.repositories.some((repository) => repository.alias === alias)) {
      throw new UserError(`project '${project.name}' has no repository '${alias}'`);
    }
    if (alias === project.rootRepositoryAlias) {
      throw new UserError("the root repository ref cannot be overridden by a workspace candidate");
    }
    if (overrides[alias] !== undefined) throw new UserError(`repository ref override '${alias}' is duplicated`);
    overrides[alias] = normalizeRepositoryRef(value.slice(separator + 1));
  }
  return overrides;
}

export async function detectWorkspaceKvm(
  backend: WorkspaceRecord["runtimeBackend"],
  probe: () => Promise<void> = probeKvmDevice
): Promise<boolean> {
  // runsc does not expose the KVM ioctl surface. Explicit device forwarding
  // remains useful for runc-backed privileged and rootless-Podman workspaces.
  if (backend === "gvisor") return false;
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}

export async function resolveWorkspaceKvm(
  backend: WorkspaceRecord["runtimeBackend"],
  requested: boolean | undefined,
  probe: () => Promise<void> = probeKvmDevice
): Promise<boolean> {
  const available = await detectWorkspaceKvm(backend, probe);
  if (requested === true && !available) {
    throw new UserError(`workspace KVM was requested but is unavailable for backend '${backend}'`);
  }
  return requested ?? available;
}

async function probeKvmDevice(): Promise<void> {
  const device = await stat("/dev/kvm");
  if (!device.isCharacterDevice()) throw new Error("/dev/kvm is not a character device");
}

export async function createWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  input: {
    project: string;
    name: string;
    profiles: string[];
    requiredCapabilities?: string[];
    recommendedCapabilities?: string[];
    repositoryRefs?: string[];
    runtimeBackend: WorkspaceRecord["runtimeBackend"];
    cpuCount?: string;
    memory?: string;
    pidsLimit?: string;
    kvm?: boolean;
    gitUserName?: string;
    gitUserEmail?: string;
  },
  plugins: Pick<RegisteredDimPlugins, "workspaceCapabilityProviders"> = { workspaceCapabilityProviders: new Map() }
): Promise<WorkspaceRecord> {
  const project = validateLifecycleName(input.project, "project");
  const name = validateLifecycleName(input.name, "workspace");
  const profiles = validateWorkspaceProfiles(input.profiles);
  validateWorkspaceResources({
    cpuCount: input.cpuCount ?? options.cpuCount,
    memory: input.memory ?? options.memory,
    pidsLimit: input.pidsLimit ?? options.pidsLimit
  });
  const state = new LifecycleState(options.stateRoot);
  const projectRecord = await readyProject(state, project);
  const capabilities = await resolveWorkspaceCapabilities(
    input.requiredCapabilities ?? [], input.recommendedCapabilities ?? [], projectRecord, name,
    input.runtimeBackend, plugins.workspaceCapabilityProviders
  );
  const repositoryRefOverrides = validateRepositoryRefOverrides(input.repositoryRefs ?? [], projectRecord);
  let repo = readyRootRepository(projectRecord);
  const rootRef = await resolveRootRef(runner, options, projectRecord, repo);
  if (repo.protectionPhase !== "applied") {
    repo = await applyProjectRepositoryProtection(runner, options, projectRecord.name, repo.alias);
  }
  const now = new Date().toISOString();
  const gitUserName = input.gitUserName ?? process.env.DIM_GIT_USER_NAME ?? `dim/${name}`;
  const gitUserEmail = input.gitUserEmail ?? process.env.DIM_GIT_USER_EMAIL ?? `${name}@dim.invalid`;
  let record: WorkspaceRecord;

  try {
    record = await state.readWorkspace(name);
    if (record.projectId !== projectRecord.id) {
      throw new UserError(`workspace '${name}' is already bound to project '${record.projectName}'`);
    }
    if (record.profiles.join("\0") !== profiles.join("\0")) {
      throw new UserError(`workspace '${name}' already exists with different profiles; use dim workspace update`);
    }
    if (JSON.stringify(record.capabilities ?? []) !== JSON.stringify(capabilities)) {
      throw new UserError(`workspace '${name}' already exists with different capability requests`);
    }
    if (JSON.stringify(record.repositoryRefOverrides ?? {}) !== JSON.stringify(repositoryRefOverrides)) {
      throw new UserError(`workspace '${name}' already exists with different repository ref overrides`);
    }
    if (record.runtimeBackend !== input.runtimeBackend) {
      throw new UserError(`workspace '${name}' already exists with backend '${record.runtimeBackend}'`);
    }
    if (input.kvm !== undefined && record.kvm !== input.kvm) {
      throw new UserError(`workspace '${name}' already exists with KVM ${record.kvm ? "enabled" : "disabled"}`);
    }
    if (
      record.cpuCount !== (input.cpuCount ?? options.cpuCount)
      || record.memory !== (input.memory ?? options.memory)
      || record.pidsLimit !== (input.pidsLimit ?? options.pidsLimit)
    ) {
      throw new UserError(`workspace '${name}' already exists with different resource limits`);
    }
  } catch (error) {
    if (!(error instanceof UserError) || !error.message.includes("not found")) throw error;
    const kvm = await resolveWorkspaceKvm(input.runtimeBackend, input.kvm);
    record = {
      schemaVersion: 3,
      name,
      projectId: projectRecord.id,
      projectName: projectRecord.name,
      rootRepositoryAlias: repo.alias,
      rootRef,
      repositoryRefOverrides,
      projectPath: "/workspace/project",
      phase: "creating",
      profiles,
      capabilities,
      composeProjectName: `dim-${name}`,
      containerName: `dim-ws-${name}`,
      networkName: GITEA_NETWORK,
      dockerVolumeName: `dim-ws-${name}-docker`,
      runtimeBackend: input.runtimeBackend,
      kvm,
      cpuCount: input.cpuCount ?? options.cpuCount,
      memory: input.memory ?? options.memory,
      pidsLimit: input.pidsLimit ?? options.pidsLimit,
      routes: [],
      gitUserName,
      gitUserEmail,
      gitBaseUrl: `http://dim-gitea:3000/${projectRecord.gitNamespace}`,
      hostAliases: {},
      projectManifestPath: "/run/dim/project.json",
      createdAt: now,
      updatedAt: now
    };
    await state.claimWorkspace(record);
  }

  const release = await state.acquireWorkspaceSetupLock(name);
  try {
    const reconciled = await reconcileProject(runner, options, state, record, projectRecord, repo);
    return await setupWorkspaceLocked(runner, options, state, reconciled);
  } finally {
    await release();
  }
}

export async function runWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  input: WorkspaceCommandInput
): Promise<number> {
  const record = await runnableWorkspace(runner, options, input.name);
  if (input.command.length === 0) throw new UserError("dim workspace run requires a task");
  const hasEntrypoint = await projectFileExists(runner, record, ".dim/entrypoint.sh");
  const command = hasEntrypoint
    ? ["sh", ".dim/entrypoint.sh", ...input.command]
    : input.command;
  return streamProjectCommand(runner, record, command, input.interactive, true);
}

export async function execWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  input: WorkspaceCommandInput
): Promise<number> {
  const record = await showWorkspace(options, input.name);
  await assertContainerRunning(runner, record);
  if (input.command.length === 0) throw new UserError("dim workspace exec requires a command");
  return streamProjectCommand(runner, record, input.command, input.interactive, true);
}

export async function setupWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  profilesChanged = false
): Promise<WorkspaceRecord> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    return await setupWorkspaceLocked(runner, options, state, await state.readWorkspace(workspaceName), profilesChanged);
  } finally {
    await release();
  }
}

async function setupWorkspaceLocked(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  state: LifecycleState,
  initialRecord: WorkspaceRecord,
  profilesChanged = false,
  forceRecreate = false
): Promise<WorkspaceRecord> {
  let record = initialRecord;
  await assertContainerRunning(runner, record);
  const startedAt = new Date().toISOString();
  record = {
    ...record,
    phase: "setting-up",
    lastSetup: { startedAt },
    updatedAt: startedAt
  };
  delete record.error;
  await state.writeWorkspace(record);

  const exitCode = await runProjectSetup(runner, record, profilesChanged, forceRecreate);
  const completedAt = new Date().toISOString();
  if (exitCode !== 0) {
    const setupError = `project setup exited with ${exitCode}`;
    record = {
      ...record,
      phase: "setup-error",
      lastSetup: { startedAt, completedAt, exitCode, error: setupError },
      updatedAt: completedAt,
      error: setupError
    };
    await state.writeWorkspace(record);
    throw new UserError(setupError);
  }
  record = {
    ...record,
    phase: "ready",
    lastSetup: { startedAt, completedAt, exitCode: 0 },
    updatedAt: completedAt
  };
  delete record.error;
  await state.writeWorkspace(record);
  return record;
}

export async function updateWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  profiles?: string[]
): Promise<WorkspaceRecord> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  let record = await state.readWorkspace(workspaceName);
  const oldProfiles = record.profiles;
  const nextProfiles = profiles === undefined ? oldProfiles : validateWorkspaceProfiles(profiles);
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    await assertContainerRunning(runner, record);
    await fastForwardRoot(runner, record);
    record = { ...record, profiles: nextProfiles, updatedAt: new Date().toISOString() };
    await state.writeWorkspace(record);
    return await setupWorkspaceLocked(
      runner,
      options,
      state,
      record,
      oldProfiles.join("\0") !== nextProfiles.join("\0")
    );
  } finally {
    await release();
  }
}

export async function alignWorkspaceRoot(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  reset = false
): Promise<WorkspaceRecord> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    const record = await state.readWorkspace(workspaceName);
    await assertContainerRunning(runner, record);
    const status = await projectCommand(runner, record, ["git", "status", "--porcelain"]);
    if (status.exitCode !== 0) throw commandError("inspect project Git status", status);
    if (!reset && status.stdout.trim()) {
      throw new UserError(`workspace '${workspaceName}' has uncommitted project changes`);
    }
    const fetch = await projectCommand(runner, record, ["git", "fetch", "origin", record.rootRef]);
    if (fetch.exitCode !== 0) throw commandError(`fetch root ref '${record.rootRef}'`, fetch);
    if (record.rootRef.startsWith("refs/heads/")) {
      const branch = record.rootRef.slice("refs/heads/".length);
      const align = await projectCommand(
        runner,
        record,
        reset
          ? ["git", "switch", "--discard-changes", "--force-create", branch, "FETCH_HEAD"]
          : ["git", "switch", branch]
      );
      if (align.exitCode !== 0) throw commandError(`switch to root branch '${branch}'`, align);
      if (!reset) {
        const merge = await projectCommand(runner, record, ["git", "merge", "--ff-only", "FETCH_HEAD"]);
        if (merge.exitCode !== 0) throw commandError(`fast-forward root ref '${record.rootRef}'`, merge);
      }
    } else {
      const checkout = await projectCommand(
        runner,
        record,
        reset
          ? ["git", "switch", "--discard-changes", "--detach", "FETCH_HEAD"]
          : ["git", "switch", "--detach", "FETCH_HEAD"]
      );
      if (checkout.exitCode !== 0) throw commandError(`check out root ref '${record.rootRef}'`, checkout);
    }
    if (reset) {
      const clean = await projectCommand(runner, record, ["git", "clean", "-fd"]);
      if (clean.exitCode !== 0) throw commandError("clean reset project checkout", clean);
    }
    return record;
  } finally {
    await release();
  }
}

export async function startWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<WorkspaceRecord> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    return await startWorkspaceLocked(runner, options, state, workspaceName);
  } finally {
    await release();
  }
}

interface RootFastForwardPlan {
  rootRef: string;
  commit: string;
}

async function startWorkspaceLocked(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  state: LifecycleState,
  workspaceName: string,
  target?: RootFastForwardPlan
): Promise<WorkspaceRecord> {
  const record = await state.readWorkspace(workspaceName);
  if (record.phase !== "stopped") {
    throw new UserError(`workspace '${workspaceName}' is not stopped; use restart to apply project changes`);
  }
  const project = await readyProject(state, record.projectName);
  if (project.id !== record.projectId) throw new UserError(`project '${record.projectName}' identity changed`);
  const repo = readyRootRepository(project);
  const reconciled = await reconcileProject(runner, options, state, record, project, repo);
  if (target !== undefined && reconciled.rootRef !== target.rootRef) {
    throw new UserError(`workspace '${workspaceName}' root ref changed while restart was in progress; retry restart`);
  }
  if (target === undefined) {
    await fastForwardRoot(runner, reconciled);
  } else {
    await applyFastForwardRoot(runner, reconciled, target);
  }
  return setupWorkspaceLocked(runner, options, state, reconciled, false, true);
}

export async function restartWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<WorkspaceRecord> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    const record = await state.readWorkspace(workspaceName);
    if (record.phase === "stopped") {
      return await startWorkspaceLocked(runner, options, state, workspaceName);
    }
    const project = await readyProject(state, record.projectName);
    if (project.id !== record.projectId) throw new UserError(`project '${record.projectName}' identity changed`);
    await assertContainerRunning(runner, record);
    const target = await planFastForwardRoot(runner, record);
    await stopWorkspaceLocked(runner, state, record);
    return await startWorkspaceLocked(runner, options, state, workspaceName, target);
  } finally {
    await release();
  }
}

export async function showWorkspace(options: LifecycleOptions, name: string): Promise<WorkspaceRecord> {
  return new LifecycleState(options.stateRoot).readWorkspace(validateLifecycleName(name, "workspace"));
}

export async function listWorkspaces(options: LifecycleOptions): Promise<WorkspaceRecord[]> {
  return new LifecycleState(options.stateRoot).listWorkspaces();
}

export async function updateWorkspaceResources(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  input: WorkspaceResourceInput
): Promise<WorkspaceRecord> {
  const workspaceName = validateLifecycleName(name, "workspace");
  if (input.cpuCount === undefined && input.memory === undefined && input.pidsLimit === undefined) {
    throw new UserError("provide at least one workspace resource limit");
  }
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    const record = await state.readWorkspace(workspaceName);
    const resources = {
      cpuCount: input.cpuCount ?? record.cpuCount,
      memory: input.memory ?? record.memory,
      pidsLimit: input.pidsLimit ?? record.pidsLimit
    };
    validateWorkspaceResources(resources);

    const inspect = await runner.run("docker", [
      "container", "inspect", record.containerName,
      "--format", "{{index .Config.Labels \"dim.managed\"}}|{{index .Config.Labels \"dim.workspace\"}}|{{index .Config.Labels \"dim.resource\"}}"
    ]);
    if (inspect.exitCode !== 0) {
      throw new UserError(`workspace container '${record.containerName}' is not available`);
    }
    if (inspect.stdout.trim() !== `true|${record.name}|workspace`) {
      throw new UserError(`Docker resource '${record.containerName}' conflicts with workspace '${record.name}'`);
    }

    const updated = await runner.run("docker", [
      "update",
      "--cpus", resources.cpuCount,
      "--memory", resources.memory,
      "--memory-swap", resources.memory,
      "--pids-limit", resources.pidsLimit,
      record.containerName
    ]);
    if (updated.exitCode !== 0) {
      throw new UserError(`failed to update workspace resources: ${updated.stderr.trim()}`);
    }
    const next = { ...record, ...resources, updatedAt: new Date().toISOString() };
    await state.writeWorkspace(next);
    return next;
  } finally {
    await release();
  }
}

export async function stopWorkspace(runner: StreamingCommandRunner, options: LifecycleOptions, name: string): Promise<void> {
  const state = new LifecycleState(options.stateRoot);
  const workspaceName = validateLifecycleName(name, "workspace");
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    await stopWorkspaceLocked(runner, state, await state.readWorkspace(workspaceName));
  } finally {
    await release();
  }
}

async function stopWorkspaceLocked(
  runner: StreamingCommandRunner,
  state: LifecycleState,
  initialRecord: WorkspaceRecord
): Promise<void> {
  const inspect = await runner.run("docker", [
    "container", "inspect", initialRecord.containerName, "--format", "{{.State.Running}}"
  ]);
  if (inspect.exitCode === 0 && inspect.stdout.trim() === "true") {
    const exitCode = await runner.runStreaming("docker", ["stop", initialRecord.containerName]);
    if (exitCode !== 0) throw new UserError(`failed to stop workspace '${initialRecord.name}'`);
  }
  const record = { ...initialRecord, phase: "stopped" as const, updatedAt: new Date().toISOString() };
  delete record.error;
  await state.writeWorkspace(record);
}

export async function discardWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  keepVolume = false
): Promise<void> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    const record = await state.readWorkspace(workspaceName);
    const inspect = await runner.run("docker", ["container", "inspect", record.containerName, "--format", "{{.State.Running}}"]);
    if (inspect.exitCode === 0) {
      if (inspect.stdout.trim() !== "true") {
        await runner.run("docker", ["start", record.containerName]);
        await waitForInnerDocker(runner, record.containerName);
      }
      await runProjectTeardown(runner, record);
    }
    const removed = await runner.run("docker", ["container", "rm", "--force", record.containerName]);
    if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) {
      throw new UserError(`failed to remove workspace container: ${removed.stderr.trim()}`);
    }
    if (!keepVolume) {
      const volume = await runner.run("docker", ["volume", "rm", record.dockerVolumeName]);
      if (volume.exitCode !== 0 && !volume.stderr.includes("No such volume")) {
        throw new UserError(`failed to remove workspace Docker volume: ${volume.stderr.trim()}`);
      }
    }
    await state.removeWorkspace(workspaceName);
    await state.removeWorkspaceGrant(workspaceName);
    await state.removeAgentGrant(workspaceName);
  } finally {
    await release();
  }
}

async function reconcileProject(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  state: LifecycleState,
  initialRecord: WorkspaceRecord,
  project: ProjectRecord,
  repo: ProjectRepositoryRecord
): Promise<WorkspaceRecord> {
  const release = await state.acquireWorkspaceLock(initialRecord.name);
  let record = await state.readWorkspace(initialRecord.name);
  try {
    try {
      const credentials = await ensureGitea(runner, options);
      const gitBaseUrl = `${await giteaNestedBaseUrl(runner)}/${project.gitNamespace}`;
      const giteaAddress = new URL(gitBaseUrl).hostname;
      const rootRef = await resolveRootRef(runner, options, project, repo, credentials);
      record = {
        ...record,
        projectName: project.name,
        rootRepositoryAlias: repo.alias,
        rootRef,
        gitBaseUrl,
        hostAliases: { "dim-gitea": [giteaAddress] }
      };
      await state.writeWorkspace(record);
      await reconcileContainer(runner, options, record, gitEnvironment(record, credentials));
      await installHostInputHelper(runner, record);
      await ensureClone(runner, record, repo.workspaceUrl);
      await writeProjectManifest(runner, record, project, credentials);
      record = { ...record, updatedAt: new Date().toISOString() };
      await state.writeWorkspace(record);
      return record;
    } catch (error) {
      record = {
        ...record,
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      };
      await state.writeWorkspace(record);
      throw error;
    }
  } finally {
    await release();
  }
}

async function readyProject(state: LifecycleState, project: string): Promise<ProjectRecord> {
  const record = await state.readProject(project);
  if (record.phase !== "ready") throw new UserError(`project '${project}' is not ready (phase: ${record.phase})`);
  return record;
}

function gitEnvironment(record: WorkspaceRecord, credentials: GiteaCredentials): WorkspaceGitEnvironment {
  return {
    username: credentials.writerUsername,
    token: credentials.writerPassword,
    userName: record.gitUserName,
    userEmail: record.gitUserEmail
  };
}

async function runnableWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<WorkspaceRecord> {
  const record = await showWorkspace(options, name);
  if (record.phase !== "ready") {
    throw new UserError(`workspace '${record.name}' is not ready (phase: ${record.phase}); run dim workspace setup`);
  }
  await assertContainerRunning(runner, record);
  return record;
}

async function assertContainerRunning(runner: StreamingCommandRunner, record: WorkspaceRecord): Promise<void> {
  const inspect = await runner.run("docker", ["container", "inspect", record.containerName, "--format", "{{.State.Running}}"]);
  if (inspect.exitCode !== 0 || inspect.stdout.trim() !== "true") {
    throw new UserError(`workspace '${record.name}' is stopped; run dim workspace start`);
  }
}

async function reconcileContainer(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  record: WorkspaceRecord,
  git: WorkspaceGitEnvironment
): Promise<void> {
  if (record.kvm) {
    try {
      await probeKvmDevice();
    } catch {
      throw new UserError(`workspace '${record.name}' requires host /dev/kvm`);
    }
  }
  const registryCache = await ensureRegistryCache(runner);
  await reconcileDockerVolume(runner, record);
  const state = new LifecycleState(options.stateRoot);
  const controllerGrant = await state.ensureWorkspaceGrant(record.name);
  const agentGrant = await state.ensureAgentGrant(record.name);
  const inspectArgs = [
    "container", "inspect", record.containerName,
    "--format",
    "{{index .Config.Labels \"dim.managed\"}}|{{index .Config.Labels \"dim.workspace\"}}|{{index .Config.Labels \"dim.project\"}}|{{index .Config.Labels \"dim.repo\"}}|{{index .Config.Labels \"dim.backend\"}}|{{index .Config.Labels \"dim.runtime-config\"}}|{{.State.Running}}"
  ];
  let inspect = await runner.run("docker", inspectArgs);
  if (inspect.exitCode !== 0) {
    const created = await runner.run("docker", workspaceContainerArgs(
      options, record, git, controllerGrant, undefined, agentGrant, registryCache.address
    ));
    if (created.exitCode !== 0) {
      inspect = await runner.run("docker", inspectArgs);
      if (inspect.exitCode !== 0) {
        throw new UserError(`failed to create workspace container: ${created.stderr.trim()}`);
      }
    } else {
      inspect = await runner.run("docker", inspectArgs);
    }
  }
  let [managed, workspace, projectLabel, repoLabel, backend, runtimeConfig, running] = inspect.stdout.trim().split("|");
  if (
    managed !== "true"
    || workspace !== record.name
    || projectLabel !== record.projectName
    || repoLabel !== record.rootRepositoryAlias
    || backend !== record.runtimeBackend
  ) {
    throw new UserError(`Docker resource '${record.containerName}' conflicts with workspace '${record.name}'`);
  }
  if (runtimeConfig !== WORKSPACE_RUNTIME_CONFIG_VERSION) {
    const removed = await runner.run("docker", ["container", "rm", "--force", record.containerName]);
    if (removed.exitCode !== 0) throw new UserError(`failed to replace workspace container: ${removed.stderr.trim()}`);
    const created = await runner.run("docker", workspaceContainerArgs(
      options, record, git, controllerGrant, undefined, agentGrant, registryCache.address
    ));
    if (created.exitCode !== 0) throw new UserError(`failed to create workspace container: ${created.stderr.trim()}`);
    inspect = await runner.run("docker", inspectArgs);
    [managed, workspace, projectLabel, repoLabel, backend, runtimeConfig, running] = inspect.stdout.trim().split("|");
  }
  if (running !== "true") {
    const started = await runner.run("docker", ["start", record.containerName]);
    if (started.exitCode !== 0) throw new UserError(`failed to start workspace '${record.name}'`);
  }
  await waitForWorkspaceRuntime(
    runner,
    record.containerName,
    workspaceRuntimePlan(record.runtimeBackend, options).engine
  );
}

async function reconcileDockerVolume(runner: StreamingCommandRunner, record: WorkspaceRecord): Promise<void> {
  const inspectArgs = [
    "volume", "inspect", record.dockerVolumeName,
    "--format", "{{index .Labels \"dim.managed\"}}|{{index .Labels \"dim.workspace\"}}|{{index .Labels \"dim.resource\"}}"
  ];
  let inspect = await runner.run("docker", inspectArgs);
  if (inspect.exitCode !== 0) {
    const created = await runner.run("docker", [
      "volume", "create",
      "--label", "dim.managed=true",
      "--label", `dim.workspace=${record.name}`,
      "--label", "dim.resource=workspace-docker",
      record.dockerVolumeName
    ]);
    if (created.exitCode !== 0) {
      inspect = await runner.run("docker", inspectArgs);
      if (inspect.exitCode !== 0) throw new UserError(`failed to create workspace Docker volume: ${created.stderr.trim()}`);
    } else {
      inspect = await runner.run("docker", inspectArgs);
    }
  }
  if (inspect.stdout.trim() !== `true|${record.name}|workspace-docker`) {
    throw new UserError(`Docker volume '${record.dockerVolumeName}' conflicts with workspace '${record.name}'`);
  }
}

export function workspaceContainerArgs(
  options: LifecycleOptions,
  record: WorkspaceRecord,
  git: WorkspaceGitEnvironment,
  controllerGrant?: string,
  kvmGroupId: () => number = () => statSync("/dev/kvm").gid,
  agentGrant?: string,
  registryCacheAddress?: string
): string[] {
  const plan = workspaceRuntimePlan(record.runtimeBackend, options);
  const args = [
    "run", "--detach",
    "--name", record.containerName,
    "--network", record.networkName,
    "--add-host", "host.docker.internal:host-gateway",
    ...(registryCacheAddress ? ["--add-host", `${REGISTRY_CACHE_CONTAINER}:${registryCacheAddress}`] : []),
    "--runtime", plan.dockerRuntime,
    "--cpus", record.cpuCount,
    "--memory", record.memory,
    "--memory-swap", record.memory,
    "--pids-limit", record.pidsLimit,
    "--mount", `type=volume,source=${record.dockerVolumeName},target=${plan.runtimeDataPath}`,
    "--mount", `type=bind,source=${path.dirname(options.controllerSocketPath)},target=/run/dim/controller`,
    "--mount", `type=bind,source=${path.dirname(options.agentControllerSocketPath)},target=/run/dim/agent-controller`,
    "--label", "dim.managed=true",
    "--label", `dim.workspace=${record.name}`,
    "--label", `dim.project=${record.projectName}`,
    "--label", `dim.repo=${record.rootRepositoryAlias}`,
    "--label", `dim.backend=${record.runtimeBackend}`,
    "--label", `dim.runtime-config=${WORKSPACE_RUNTIME_CONFIG_VERSION}`,
    "--label", "dim.resource=workspace",
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
  engine: "docker" | "podman"
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
    "inspect",
    "--format",
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

async function ensureClone(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  cloneUrl: string
): Promise<void> {
  const existing = await runner.run("docker", [
    "exec", "--user", WORKSPACE_USER, record.containerName,
    "git", "-C", record.projectPath, "rev-parse", "--git-dir"
  ]);
  if (existing.exitCode === 0) return;
  const parent = record.projectPath.slice(0, record.projectPath.lastIndexOf("/")) || "/workspace";
  const directory = await runner.run("docker", ["exec", "--user", WORKSPACE_USER, record.containerName, "mkdir", "-p", parent]);
  if (directory.exitCode !== 0) throw commandError("prepare project directory", directory);
  const clone = await runner.run("docker", [
    "exec", "--user", WORKSPACE_USER, record.containerName,
    "git", "clone", "--branch", rootBranch(record.rootRef), "--single-branch", cloneUrl, record.projectPath
  ]);
  if (clone.exitCode !== 0) throw commandError(`clone project '${record.projectName}'`, clone);
}

async function fastForwardRoot(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord
): Promise<void> {
  await applyFastForwardRoot(runner, record, await planFastForwardRoot(runner, record));
}

async function planFastForwardRoot(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord
): Promise<RootFastForwardPlan> {
  const status = await projectCommand(runner, record, ["git", "status", "--porcelain"]);
  if (status.exitCode !== 0) throw commandError("inspect project Git status", status);
  if (status.stdout.trim()) {
    throw new UserError(
      `workspace '${record.name}' has uncommitted project changes; commit or remove them, or run `
      + `dim workspace align ${record.name} --reset --yes to discard them`
    );
  }
  const remote = await projectCommand(runner, record, ["git", "ls-remote", "--exit-code", "origin", record.rootRef]);
  if (remote.exitCode !== 0) throw commandError(`resolve root ref '${record.rootRef}'`, remote);
  const [candidate, resolvedRef, ...extra] = remote.stdout.trim().split(/\s+/);
  if (extra.length !== 0 || resolvedRef !== record.rootRef || !/^[0-9a-f]{40,64}$/.test(candidate ?? "")) {
    throw new UserError(`managed root ref '${record.rootRef}' returned an invalid Git object ID`);
  }
  const commit = candidate as string;
  const fetch = await projectCommand(runner, record, ["git", "fetch", "--no-write-fetch-head", "origin", commit]);
  if (fetch.exitCode !== 0) throw commandError(`fetch root ref '${record.rootRef}'`, fetch);
  const behind = await projectCommand(runner, record, ["git", "merge-base", "--is-ancestor", "HEAD", commit]);
  if (behind.exitCode !== 0 && behind.exitCode !== 1) {
    throw commandError(`check fast-forward to root ref '${record.rootRef}'`, behind);
  }
  const ahead = behind.exitCode === 1
    ? await projectCommand(runner, record, ["git", "merge-base", "--is-ancestor", commit, "HEAD"])
    : undefined;
  if (ahead !== undefined && ahead.exitCode === 1) {
    throw new UserError(
      `workspace '${record.name}' cannot fast-forward to '${record.rootRef}'; run `
      + `dim workspace align ${record.name} --reset --yes to discard divergent local commits`
    );
  }
  if (ahead !== undefined && ahead.exitCode !== 0) {
    throw commandError(`check local root compatibility with '${record.rootRef}'`, ahead);
  }
  return { rootRef: record.rootRef, commit };
}

async function applyFastForwardRoot(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  target: RootFastForwardPlan
): Promise<void> {
  const merge = await projectCommand(runner, record, ["git", "merge", "--ff-only", target.commit]);
  if (merge.exitCode !== 0) throw commandError(`fast-forward root ref '${record.rootRef}'`, merge);
}

async function writeProjectManifest(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  project: ProjectRecord,
  credentials: GiteaCredentials
): Promise<void> {
  const cgroups = await inspectProjectRuntimeCgroups(runner, record.containerName, nestedEngine(record));
  const repositories = await resolveRepositorySnapshot(runner, record, project, credentials);
  const manifest = projectRuntimeManifest(record, project, cgroups, repositories);
  const encoded = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`).toString("base64");
  const result = await runner.run("docker", [
    "exec", "--user", "root",
    "--env", `DIM_PROJECT_MANIFEST_B64=${encoded}`,
    record.containerName,
    "sh", "-c",
    `mkdir -p /run/dim && printf %s "$DIM_PROJECT_MANIFEST_B64" | base64 -d > ${record.projectManifestPath} && chown ${WORKSPACE_USER}:${WORKSPACE_USER} ${record.projectManifestPath} && chmod 0444 ${record.projectManifestPath}`
  ]);
  if (result.exitCode !== 0) throw commandError("write project runtime manifest", result);
}

export function projectRuntimeManifest(
  record: WorkspaceRecord,
  project: ProjectRecord,
  cgroups: ProjectRuntimeCgroups,
  resolvedRepositories: Record<string, { requestedRef: string; ref: string; commit: string }> = {}
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    project: { id: project.id, name: project.name },
    root: { repository: record.rootRepositoryAlias, ref: record.rootRef, path: record.projectPath },
    repositories: Object.fromEntries(project.repositories
      .slice()
      .sort((left, right) => left.alias.localeCompare(right.alias))
      .map((repository) => [repository.alias, {
        workspaceUrl: repository.workspaceUrl,
        phase: repository.phase,
        root: repository.alias === record.rootRepositoryAlias,
        ...(resolvedRepositories[repository.alias] ?? {})
      }])),
    gitBaseUrl: record.gitBaseUrl,
    hostAliases: record.hostAliases,
    runtime: {
      cgroups,
      capabilities: (record.capabilities ?? []).map(({ name, requirement, status, plugin, detail }) => ({
        name, requirement, status, ...(plugin ? { plugin } : {}), ...(detail ? { detail } : {})
      }))
    }
  };
}

export async function resolveRepositorySnapshot(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  project: ProjectRecord,
  credentials: GiteaCredentials
): Promise<Record<string, { requestedRef: string; ref: string; commit: string }>> {
  const resolved: Record<string, { requestedRef: string; ref: string; commit: string }> = {};
  const helper = "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f";
  for (const repository of project.repositories) {
    if (repository.phase !== "ready") continue;
    const requestedRef = record.repositoryRefOverrides?.[repository.alias]
      ?? repository.ref
      ?? (repository.alias === record.rootRepositoryAlias ? record.rootRef : "HEAD");
    const requestedCommit = /^[0-9a-f]{40,64}$/.test(requestedRef) ? requestedRef : undefined;
    const listed = await runner.run(
      "git",
      ["-c", `credential.helper=${helper}`, "ls-remote", "--symref", "--exit-code", repository.hostUrl, ...(requestedCommit ? [] : [requestedRef, `${requestedRef}^{}`])],
      {
        env: {
          ...process.env,
          DIM_GIT_USERNAME: credentials.writerUsername,
          DIM_GIT_TOKEN: credentials.writerPassword,
          GIT_TERMINAL_PROMPT: "0"
        }
      }
    );
    if (listed.exitCode !== 0) {
      throw commandError(`resolve repository ref '${project.name}/${repository.alias}:${requestedRef}'`, listed);
    }
    const lines = listed.stdout.trim().split(/\r?\n/).filter(Boolean);
    const symbolic = requestedRef === "HEAD"
      ? lines.find((line) => line.startsWith("ref:"))?.match(/^ref:\s+(refs\/[^\s]+)\s+HEAD$/)?.[1]
      : undefined;
    const objectLine = requestedCommit
      ? lines.find((line) => line.startsWith(`${requestedCommit}\t`))
      : lines.find((line) => line.endsWith(`\t${requestedRef}^{}`))
        ?? lines.find((line) => /^[0-9a-f]{40,64}\s+/.test(line));
    const [commit, reportedRef] = objectLine?.split(/\s+/, 2) ?? [];
    if (!commit || !reportedRef) {
      throw new UserError(`repository ref '${project.name}/${repository.alias}:${requestedRef}' returned no commit`);
    }
    resolved[repository.alias] = {
      requestedRef,
      ref: requestedCommit ?? symbolic ?? reportedRef.replace(/\^\{\}$/, ""),
      commit
    };
  }
  return resolved;
}

const HOST_INPUT_HELPER = `#!/usr/bin/env sh
set -eu
provider="\${1:?host input provider is required}"
key="\${2:?host input key is required}"
parameters="\${3-}"
: "\${DIM_CONTROLLER_SOCKET:?DIM_CONTROLLER_SOCKET is required}"
: "\${DIM_CONTROLLER_TOKEN:?DIM_CONTROLLER_TOKEN is required}"
if [ "$#" -ge 3 ]; then
  body="$(jq -cn --arg key "$key" --arg parameters "$parameters" '{key: $key, parameters: $parameters}')"
else
  body="$(jq -cn --arg key "$key" '{key: $key}')"
fi
curl --fail --silent --show-error \\
  --unix-socket "$DIM_CONTROLLER_SOCKET" \\
  --header "Authorization: Bearer $DIM_CONTROLLER_TOKEN" \\
  --header "Content-Type: application/json" \\
  --data "$body" \\
  "http://dim-controller/api/host-inputs/$provider" |
  jq -er '.value'
`;

async function installHostInputHelper(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord
): Promise<void> {
  const encoded = Buffer.from(HOST_INPUT_HELPER).toString("base64");
  const result = await runner.run("docker", [
    "exec", "--user", "root",
    "--env", `DIM_HOST_INPUT_HELPER_B64=${encoded}`,
    record.containerName,
    "sh", "-c",
    "printf %s \"$DIM_HOST_INPUT_HELPER_B64\" | base64 -d > /usr/local/bin/dim-host-input && chmod 0755 /usr/local/bin/dim-host-input"
  ]);
  if (result.exitCode !== 0) throw commandError("install host input helper", result);
}

async function runProjectSetup(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  profilesChanged: boolean,
  forceRecreate: boolean
): Promise<number> {
  const engine = nestedEngine(record);
  const profileArgs = repeatedProfileArgs(record.profiles);
  if (await projectFileExists(runner, record, ".dim/setup.sh")) {
    return streamProjectCommand(runner, record, ["sh", ".dim/setup.sh", ...profileArgs], false);
  }
  if (!(await projectFileExists(runner, record, ".dim/docker-compose.yml"))) return 0;
  if (profilesChanged) {
    const down = await streamProjectCommand(runner, record, [
      engine, "compose", "--project-name", record.composeProjectName,
      "--file", ".dim/docker-compose.yml", "--profile", "*",
      "down", "--remove-orphans"
    ], false);
    if (down !== 0) return down;
  }
  return streamProjectCommand(runner, record, [
    engine, "compose", "--project-name", record.composeProjectName,
    "--file", ".dim/docker-compose.yml",
    ...composeProfileArgs(record.profiles),
    "up", "--detach", "--build", ...(forceRecreate ? ["--force-recreate"] : [])
  ], false);
}

async function runProjectTeardown(runner: StreamingCommandRunner, record: WorkspaceRecord): Promise<void> {
  if (await projectFileExists(runner, record, ".dim/teardown.sh")) {
    await streamProjectCommand(runner, record, ["sh", ".dim/teardown.sh", ...repeatedProfileArgs(record.profiles)], false);
    return;
  }
  if (await projectFileExists(runner, record, ".dim/docker-compose.yml")) {
    await streamProjectCommand(runner, record, [
      nestedEngine(record), "compose", "--project-name", record.composeProjectName,
      "--file", ".dim/docker-compose.yml", "--profile", "*",
      "down", "--remove-orphans"
    ], false);
  }
}

function composeProfileArgs(profiles: string[]): string[] {
  return profiles.flatMap((profile) => ["--profile", profile]);
}

function repeatedProfileArgs(profiles: string[]): string[] {
  return composeProfileArgs(profiles);
}

function projectEnvironment(record: WorkspaceRecord): string[] {
  const values = [
    "--env", `DIM_PROJECT_ID=${record.projectId}`,
    "--env", `DIM_PROJECT_NAME=${record.projectName}`,
    "--env", `DIM_PROJECT_ROOT=${record.projectPath}`,
    "--env", `DIM_PROJECT_MANIFEST=${record.projectManifestPath}`,
    "--env", `DIM_WORKSPACE_NAME=${record.name}`,
    "--env", `COMPOSE_PROJECT_NAME=${record.composeProjectName}`,
    "--env", `DIM_WORKSPACE_BACKEND=${record.runtimeBackend}`,
    "--env", `DIM_WORKSPACE_KVM=${record.kvm ? "1" : "0"}`,
    "--env", `DIM_NESTED_ENGINE=${nestedEngine(record)}`,
    "--env", `COMPOSE_PROFILES=${record.profiles.join(",")}`,
    "--env", `DIM_GIT_BASE_URL=${record.gitBaseUrl}`
  ];
  return values;
}

function readyRootRepository(project: ProjectRecord): ProjectRepositoryRecord {
  if (!project.rootRepositoryAlias) {
    throw new UserError(`project '${project.name}' has no root repo`);
  }
  const repo = project.repositories.find((candidate) => candidate.alias === project.rootRepositoryAlias);
  if (!repo || repo.phase !== "ready") {
    throw new UserError(`project '${project.name}' root repo '${project.rootRepositoryAlias}' is not ready`);
  }
  return repo;
}

async function resolveRootRef(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  project: ProjectRecord,
  repo: ProjectRepositoryRecord,
  existingCredentials?: GiteaCredentials
): Promise<string> {
  if (project.rootRef) return project.rootRef;
  const credentials = existingCredentials ?? await ensureGitea(runner, options);
  const helper = "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await runner.run(
      "git",
      ["-c", `credential.helper=${helper}`, "ls-remote", "--symref", repo.hostUrl, "HEAD"],
      {
        env: {
          ...process.env,
          DIM_GIT_USERNAME: credentials.writerUsername,
          DIM_GIT_TOKEN: credentials.writerPassword,
          GIT_TERMINAL_PROMPT: "0"
        }
      }
    );
    if (result.exitCode !== 0) throw commandError(`resolve root HEAD for project '${project.name}'`, result);
    const match = result.stdout.match(/^ref:\s+(refs\/heads\/[^\s]+)\s+HEAD$/m);
    if (match?.[1]) return normalizeResolvedRootRef(match[1], project.name);
    if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new UserError(
    `project '${project.name}' has no configured root ref and repo '${repo.alias}' has no branch HEAD`
  );
}

function normalizeResolvedRootRef(ref: string, project: string): string {
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes("..") || ref.endsWith("/")) {
    throw new UserError(`project '${project}' root HEAD '${ref}' is not a valid branch`);
  }
  return ref;
}

function rootBranch(ref: string): string {
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix)) throw new UserError(`workspace root ref '${ref}' is not a branch`);
  return ref.slice(prefix.length);
}

function nestedEngine(record: WorkspaceRecord): "docker" | "podman" {
  return record.runtimeBackend === "rootless-podman" ? "podman" : "docker";
}

async function projectFileExists(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  relativePath: string
): Promise<boolean> {
  const result = await runner.run("docker", [
    "exec", "--user", WORKSPACE_USER, "--workdir", record.projectPath,
    record.containerName, "test", "-f", relativePath
  ]);
  return result.exitCode === 0;
}

async function projectCommand(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  command: string[]
) {
  const args = [
    "exec", "--user", WORKSPACE_USER, "--workdir", record.projectPath,
    ...projectEnvironment(record), record.containerName, ...command
  ];
  return runner.run("docker", args);
}

async function streamProjectCommand(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  command: string[],
  tty: boolean,
  attachStdin = false
): Promise<number> {
  const args = [
    "exec", "--user", WORKSPACE_USER, "--workdir", record.projectPath,
    ...projectEnvironment(record)
  ];
  if (attachStdin) args.push("--interactive");
  if (tty) args.push("--tty");
  args.push(record.containerName, ...command);
  return runner.runStreaming("docker", args, { terminal: tty });
}

function commandError(action: string, result: { stderr: string; stdout: string }): UserError {
  return new UserError(`failed to ${action}: ${(result.stderr || result.stdout).trim()}`);
}
