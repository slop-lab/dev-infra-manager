import { UserError } from "./errors.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import type { ProtectedRootSnapshot } from "./protectedRootSnapshot.js";
import { protectedRootSnapshotPath } from "./protectedRootSnapshot.js";
import type { StreamingCommandRunner } from "./types.js";
import { assertContainerRunning } from "./workspaceContainer.js";
import type { WorkspaceResourceInput } from "./workspaceLifecycleTypes.js";
import {
  inspectWorkspaceContainer,
  isMissingContainer
} from "./workspaceResourceOwnership.js";
import { validateWorkspaceResources } from "./workspaceValidation.js";
import { assertWorkspaceLifecycleActive } from "./workspaceRecord.js";

export async function assertSelectedProjectUnchanged(
  state: LifecycleState,
  selectedRoot: ProtectedRootSnapshot
): Promise<void> {
  const current = await state.readProject(selectedRoot.project.name);
  if (JSON.stringify(current) !== JSON.stringify(selectedRoot.project)) {
    throw new UserError(`project '${current.name}' changed while its protected root snapshot was selected; retry`);
  }
}

export async function runnableWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<WorkspaceRecord> {
  const record = await showWorkspace(runner, options, name);
  if (record.phase !== "ready") {
    throw new UserError(`workspace '${record.name}' is not ready (phase: ${record.phase}); run dim workspace setup`);
  }
  const containerId = await assertContainerRunning(runner, options.stateRoot, record);
  return { ...record, containerName: containerId };
}

export async function reconcileWorkspaceRuntimeState(
  runner: StreamingCommandRunner,
  state: LifecycleState,
  stateRoot: string,
  record: WorkspaceRecord
): Promise<WorkspaceRecord> {
  if (record.phase !== "ready" && record.phase !== "stopped") return record;
  const container = await inspectWorkspaceContainer(runner, record);
  const running = container?.running ?? false;
  // A running outer container is not sufficient evidence that reviewed Project
  // setup completed. Only DIM setup may promote a workspace back to ready.
  if (running && container?.rootSnapshotPath !== protectedRootSnapshotPath(stateRoot, record.projectId, record.rootCommit)) {
    const error = "workspace container root does not match its recorded immutable root";
    const reconciled = { ...record, phase: "error" as const, error, updatedAt: new Date().toISOString() };
    await state.writeWorkspace(reconciled);
    return reconciled;
  }
  if (running || record.phase === "stopped") return record;
  const reconciled = { ...record, phase: "stopped" as const, updatedAt: new Date().toISOString() };
  delete reconciled.error;
  await state.writeWorkspace(reconciled);
  return reconciled;
}

export async function showWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<WorkspaceRecord> {
  const state = new LifecycleState(options.stateRoot);
  const workspaceName = validateLifecycleName(name, "workspace");
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    return await reconcileWorkspaceRuntimeState(runner, state, options.stateRoot, await state.readWorkspace(workspaceName));
  } finally {
    await release();
  }
}

export async function listWorkspaces(
  runner: StreamingCommandRunner,
  options: LifecycleOptions
): Promise<WorkspaceRecord[]> {
  const state = new LifecycleState(options.stateRoot);
  const records = await state.listWorkspaces();
  const reconciled: WorkspaceRecord[] = [];
  for (const record of records) {
    const release = await state.acquireWorkspaceSetupLock(record.name);
    try {
      reconciled.push(await reconcileWorkspaceRuntimeState(runner, state, options.stateRoot, await state.readWorkspace(record.name)));
    } finally {
      await release();
    }
  }
  return reconciled;
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
    assertWorkspaceLifecycleActive(record);
    const resources = {
      cpuCount: input.cpuCount ?? record.cpuCount,
      memory: input.memory ?? record.memory,
      pidsLimit: input.pidsLimit ?? record.pidsLimit
    };
    validateWorkspaceResources(resources);
    const container = await inspectWorkspaceContainer(runner, record);
    if (container === undefined) {
      throw new UserError(`workspace container '${record.containerName}' is not available`);
    }
    const updated = await runner.run("docker", [
      "update",
      "--cpus", resources.cpuCount,
      "--memory", resources.memory,
      "--memory-swap", resources.memory,
      "--pids-limit", resources.pidsLimit,
      container.id
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

export async function stopWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<void> {
  const state = new LifecycleState(options.stateRoot);
  const workspaceName = validateLifecycleName(name, "workspace");
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    await stopWorkspaceLocked(runner, state, await state.readWorkspace(workspaceName));
  } finally {
    await release();
  }
}

export async function stopWorkspaceLocked(
  runner: StreamingCommandRunner,
  state: LifecycleState,
  initialRecord: WorkspaceRecord
): Promise<void> {
  assertWorkspaceLifecycleActive(initialRecord);
  const container = await inspectWorkspaceContainer(runner, initialRecord);
  if (container?.running) {
    const stopped = await runner.run("docker", ["stop", container.id]);
    if (stopped.exitCode !== 0 && !isMissingContainer(stopped.stderr, container.id)) {
      throw new UserError(`failed to stop workspace '${initialRecord.name}': ${stopped.stderr.trim()}`);
    }
  }
  const record = { ...initialRecord, phase: "stopped" as const, updatedAt: new Date().toISOString() };
  delete record.error;
  await state.writeWorkspace(record);
}
