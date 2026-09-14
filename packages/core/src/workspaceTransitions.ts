import { UserError } from "./errors.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import { resolveProtectedRootSnapshot } from "./protectedRootSnapshot.js";
import type { StreamingCommandRunner } from "./types.js";
import { assertContainerRunning } from "./workspaceContainer.js";
import {
  applySelectedRoot,
  planFastForwardRoot,
  resolveWorkspacePublication,
  type ResolvedWorkspacePublicationTarget
} from "./workspacePublication.js";
import { reconcileProject, setupWorkspaceLocked } from "./workspaceSetup.js";
import {
  assertSelectedProjectUnchanged,
  reconcileWorkspaceRuntimeState,
  stopWorkspaceLocked
} from "./workspaceState.js";
import { validateWorkspaceProfiles } from "./workspaceValidation.js";

export async function updateWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  profiles?: string[]
): Promise<WorkspaceRecord> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const initialRecord = await state.readWorkspace(workspaceName);
  const selectedRoot = await resolveProtectedRootSnapshot({ runner, options, projectName: initialRecord.projectName });
  const releaseProject = await state.acquireProjectLock(initialRecord.projectName);
  try {
    await assertSelectedProjectUnchanged(state, selectedRoot);
    const release = await state.acquireWorkspaceSetupLock(workspaceName);
    try {
      let record = await state.readWorkspace(workspaceName);
      if (selectedRoot.project.id !== record.projectId) throw new UserError(`project '${record.projectName}' identity changed`);
      const oldProfiles = record.profiles;
      const nextProfiles = profiles === undefined ? oldProfiles : validateWorkspaceProfiles(profiles);
      const containerId = await assertContainerRunning(runner, record);
      await planFastForwardRoot(runner, { ...record, containerName: containerId }, selectedRoot);
      const target = await resolveWorkspacePublication({ runner, options, record, target: selectedRoot });
      record = await applySelectedRoot({ runner, state, record, target, containerId });
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
  } finally {
    await releaseProject();
  }
}

export async function startWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<WorkspaceRecord> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const record = await state.readWorkspace(workspaceName);
  const selectedRoot = await resolveProtectedRootSnapshot({ runner, options, projectName: record.projectName });
  const releaseProject = await state.acquireProjectLock(record.projectName);
  try {
    await assertSelectedProjectUnchanged(state, selectedRoot);
    const target = await resolveWorkspacePublication({ runner, options, record, target: selectedRoot });
    const release = await state.acquireWorkspaceSetupLock(workspaceName);
    try {
      return await startWorkspaceLocked(runner, options, state, workspaceName, target);
    } finally {
      await release();
    }
  } finally {
    await releaseProject();
  }
}

async function startWorkspaceLocked(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  state: LifecycleState,
  workspaceName: string,
  selectedRoot: ResolvedWorkspacePublicationTarget
): Promise<WorkspaceRecord> {
  let record = await reconcileWorkspaceRuntimeState(runner, state, await state.readWorkspace(workspaceName));
  if (record.phase !== "stopped") {
    throw new UserError(`workspace '${workspaceName}' is not stopped; use restart to apply project changes`);
  }
  if (selectedRoot.project.id !== record.projectId) throw new UserError(`project '${record.projectName}' identity changed`);
  const reconciled = await reconcileProject(
    runner,
    options,
    state,
    record,
    selectedRoot.project,
    selectedRoot.repository
  );
  const containerId = await assertContainerRunning(runner, reconciled);
  await planFastForwardRoot(runner, { ...reconciled, containerName: containerId }, selectedRoot);
  const updated = await applySelectedRoot({ runner, state, record: reconciled, target: selectedRoot, containerId });
  return setupWorkspaceLocked(runner, options, state, updated, false, true);
}

export async function restartWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<WorkspaceRecord> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const initialRecord = await state.readWorkspace(workspaceName);
  const selectedRoot = await resolveProtectedRootSnapshot({ runner, options, projectName: initialRecord.projectName });
  const releaseProject = await state.acquireProjectLock(initialRecord.projectName);
  try {
    await assertSelectedProjectUnchanged(state, selectedRoot);
    const release = await state.acquireWorkspaceSetupLock(workspaceName);
    try {
      const record = await reconcileWorkspaceRuntimeState(runner, state, await state.readWorkspace(workspaceName));
      if (record.phase === "stopped") {
        const target = await resolveWorkspacePublication({ runner, options, record, target: selectedRoot });
        return await startWorkspaceLocked(runner, options, state, workspaceName, target);
      }
      if (selectedRoot.project.id !== record.projectId) throw new UserError(`project '${record.projectName}' identity changed`);
      const containerId = await assertContainerRunning(runner, record);
      await planFastForwardRoot(runner, { ...record, containerName: containerId }, selectedRoot);
      const target = await resolveWorkspacePublication({ runner, options, record, target: selectedRoot });
      await stopWorkspaceLocked(runner, state, record);
      return await startWorkspaceLocked(runner, options, state, workspaceName, target);
    } finally {
      await release();
    }
  } finally {
    await releaseProject();
  }
}
