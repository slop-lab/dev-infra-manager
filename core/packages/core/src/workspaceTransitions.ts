import { UserError } from "./errors.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import { resolveProtectedRootSnapshot } from "./protectedRootSnapshot.js";
import type { StreamingCommandRunner } from "./types.js";
import {
  runWorkspaceLifecycle,
  runWorkspaceLifecycleStage,
  type SetWorkspaceLifecycleStage
} from "./workspaceLifecycleError.js";
import { assertContainerRunning } from "./workspaceContainer.js";
import {
  applySelectedRoot,
  recordSelectedRoot,
} from "./workspacePublication.js";
import type { ProtectedRootSnapshot } from "./protectedRootSnapshot.js";
import { reconcileProjectContainer, setupWorkspaceLocked } from "./workspaceSetup.js";
import {
  assertSelectedProjectUnchanged,
  reconcileWorkspaceRuntimeState,
  stopWorkspaceLocked
} from "./workspaceState.js";
import { validateWorkspaceProfiles } from "./workspaceValidation.js";
import { assertWorkspaceLifecycleActive } from "./workspaceRecord.js";

export async function updateWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  profiles?: string[]
): Promise<WorkspaceRecord> {
  return runWorkspaceLifecycle("update", async (setStage) => {
    const workspaceName = validateLifecycleName(name, "workspace");
    const state = new LifecycleState(options.stateRoot);
    setStage("workspace state loading");
    const initialRecord = await state.readWorkspace(workspaceName);
    assertWorkspaceLifecycleActive(initialRecord);
    setStage("protected root selection");
    const selectedRoot = await resolveProtectedRootSnapshot({ runner, options, projectName: initialRecord.projectName });
    setStage("Project lock acquisition");
    const releaseProject = await state.acquireProjectLock(initialRecord.projectName);
    try {
      setStage("protected root validation");
      await assertSelectedProjectUnchanged(state, selectedRoot);
      setStage("workspace setup lock acquisition");
      const release = await state.acquireWorkspaceSetupLock(workspaceName);
      try {
        setStage("workspace state loading");
        let record = await state.readWorkspace(workspaceName);
        assertWorkspaceLifecycleActive(record);
        if (selectedRoot.project.id !== record.projectId) throw new UserError(`project '${record.projectName}' identity changed`);
        const oldProfiles = record.profiles;
        setStage("profile validation");
        const nextProfiles = profiles === undefined ? oldProfiles : validateWorkspaceProfiles(profiles);
        setStage("workspace container readiness");
        let containerId = await assertContainerRunning(runner, options.stateRoot, record);
        if (record.rootCommit !== selectedRoot.rootCommit) {
          setStage("selected root recording");
          record = await recordSelectedRoot(state, record, selectedRoot);
          setStage("workspace reconciliation");
          const reconciled = await reconcileProjectContainer({
            runner,
            options,
            state,
            record,
            project: selectedRoot.project,
            repo: selectedRoot.repository,
            setStage
          });
          record = reconciled.record;
          containerId = reconciled.containerId;
        }
        setStage("protected root publication");
        record = await applySelectedRoot({ runner, state, record, target: selectedRoot, containerId });
        record = { ...record, profiles: nextProfiles, updatedAt: new Date().toISOString() };
        setStage("workspace state publication");
        await state.writeWorkspace(record);
        return await setupWorkspaceLocked(
          runner,
          options,
          state,
          record,
          oldProfiles.join("\0") !== nextProfiles.join("\0"),
          false,
          setStage
        );
      } finally {
        await runWorkspaceLifecycleStage("update", "workspace setup lock release", release);
      }
    } finally {
      await runWorkspaceLifecycleStage("update", "Project lock release", releaseProject);
    }
  });
}

export async function startWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<WorkspaceRecord> {
  return runWorkspaceLifecycle("start", async (setStage) => {
    const workspaceName = validateLifecycleName(name, "workspace");
    const state = new LifecycleState(options.stateRoot);
    setStage("workspace state loading");
    const record = await state.readWorkspace(workspaceName);
    assertWorkspaceLifecycleActive(record);
    setStage("protected root selection");
    const selectedRoot = await resolveProtectedRootSnapshot({ runner, options, projectName: record.projectName });
    setStage("Project lock acquisition");
    const releaseProject = await state.acquireProjectLock(record.projectName);
    try {
      setStage("protected root validation");
      await assertSelectedProjectUnchanged(state, selectedRoot);
      setStage("workspace setup lock acquisition");
      const release = await state.acquireWorkspaceSetupLock(workspaceName);
      try {
        return await startWorkspaceLocked(runner, options, state, workspaceName, selectedRoot, setStage);
      } finally {
        await runWorkspaceLifecycleStage("start", "workspace setup lock release", release);
      }
    } finally {
      await runWorkspaceLifecycleStage("start", "Project lock release", releaseProject);
    }
  });
}

async function startWorkspaceLocked(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  state: LifecycleState,
  workspaceName: string,
  selectedRoot: ProtectedRootSnapshot,
  setStage: SetWorkspaceLifecycleStage
): Promise<WorkspaceRecord> {
  setStage("workspace runtime reconciliation");
  let record = await reconcileWorkspaceRuntimeState(runner, state, options.stateRoot, await state.readWorkspace(workspaceName));
  assertWorkspaceLifecycleActive(record);
  if (record.phase !== "stopped") {
    throw new UserError(`workspace '${workspaceName}' is not stopped; use restart to apply project changes`);
  }
  if (selectedRoot.project.id !== record.projectId) throw new UserError(`project '${record.projectName}' identity changed`);
  setStage("selected root recording");
  record = await recordSelectedRoot(state, record, selectedRoot);
  setStage("workspace reconciliation");
  const reconciled = await reconcileProjectContainer({
    runner,
    options,
    state,
    record,
    project: selectedRoot.project,
    repo: selectedRoot.repository,
    setStage
  });
  setStage("protected root publication");
  const updated = await applySelectedRoot({
    runner, state, record: reconciled.record, target: selectedRoot, containerId: reconciled.containerId
  });
  return setupWorkspaceLocked(runner, options, state, updated, false, true, setStage);
}

export async function restartWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<WorkspaceRecord> {
  return runWorkspaceLifecycle("restart", async (setStage) => {
    const workspaceName = validateLifecycleName(name, "workspace");
    const state = new LifecycleState(options.stateRoot);
    setStage("workspace state loading");
    const initialRecord = await state.readWorkspace(workspaceName);
    assertWorkspaceLifecycleActive(initialRecord);
    setStage("protected root selection");
    const selectedRoot = await resolveProtectedRootSnapshot({ runner, options, projectName: initialRecord.projectName });
    setStage("Project lock acquisition");
    const releaseProject = await state.acquireProjectLock(initialRecord.projectName);
    try {
      setStage("protected root validation");
      await assertSelectedProjectUnchanged(state, selectedRoot);
      setStage("workspace setup lock acquisition");
      const release = await state.acquireWorkspaceSetupLock(workspaceName);
      try {
        setStage("workspace runtime reconciliation");
        const record = await reconcileWorkspaceRuntimeState(runner, state, options.stateRoot, await state.readWorkspace(workspaceName));
        assertWorkspaceLifecycleActive(record);
        if (record.phase === "stopped") {
          return await startWorkspaceLocked(runner, options, state, workspaceName, selectedRoot, setStage);
        }
        if (selectedRoot.project.id !== record.projectId) throw new UserError(`project '${record.projectName}' identity changed`);
        setStage("workspace container readiness");
        const containerId = await assertContainerRunning(runner, options.stateRoot, record);
        setStage("workspace stop");
        await stopWorkspaceLocked(runner, state, record);
        return await startWorkspaceLocked(runner, options, state, workspaceName, selectedRoot, setStage);
      } finally {
        await runWorkspaceLifecycleStage("restart", "workspace setup lock release", release);
      }
    } finally {
      await runWorkspaceLifecycleStage("restart", "Project lock release", releaseProject);
    }
  });
}
