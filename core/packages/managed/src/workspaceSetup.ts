import { UserError } from "@slop-lab/dim-core";
import { requireNativeControlPlaneConnection } from "./lifecycleOptions.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type {
  LifecycleOptions,
  WorkspaceRecord
} from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";
import { writeProjectManifest } from "./workspaceRepositorySnapshot.js";
import { assertContainerRunning, reconcileContainer } from "./workspaceContainer.js";
import {
  combineWorkspaceLifecycleFailures,
  runWorkspaceLifecycle,
  runWorkspaceLifecycleStage,
  type SetWorkspaceLifecycleErrorStage, type SetWorkspaceLifecycleStage
} from "./workspaceLifecycleError.js";
import { assertRootSnapshot, installHostInputHelper, runProjectSetup } from "./workspaceProjectCommands.js";
import { inspectWorkspaceContainer } from "./workspaceResourceOwnership.js";
import { assertWorkspaceLifecycleActive } from "./workspaceRecord.js";
import { readWorkspaceForOperation } from "./workspaceValidation.js";
import { notifyRecommendedWorkspaceRelayPhase, reconcileWorkspaceAgent } from "./workspaceAgentLifecycle.js";
import { publishWorkspacePhase } from "./workspacePhasePublication.js";

export async function setupWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  profilesChanged = false
): Promise<WorkspaceRecord> {
  requireNativeControlPlaneConnection(options);
  return runWorkspaceLifecycle("setup", async (setStage, setErrorStage) => {
    const workspaceName = validateLifecycleName(name, "workspace");
    const state = new LifecycleState(options.stateRoot);
    setStage("workspace state loading");
    const initialRecord = await readWorkspaceForOperation(state, workspaceName);
    assertWorkspaceLifecycleActive(initialRecord);
    setStage("Project lock acquisition");
    const releaseProject = await state.acquireProjectLock(initialRecord.projectName);
    try {
      setStage("workspace setup lock acquisition");
      const release = await state.acquireWorkspaceSetupLock(workspaceName);
      try {
        setStage("workspace state loading");
        let record = await readWorkspaceForOperation(state, workspaceName);
        assertWorkspaceLifecycleActive(record);
        if (record.projectName !== initialRecord.projectName || record.projectId !== initialRecord.projectId) {
          throw new UserError(`project '${record.projectName}' identity changed`);
        }
        setStage("protected root validation");
        await assertRootSnapshot(options.stateRoot, record);
        const container = await inspectWorkspaceContainer(runner, record);
        const settingUp = { ...record, phase: "setting-up" as const, updatedAt: new Date().toISOString() };
        delete settingUp.error;
        await publishWorkspacePhase({
          runner,
          state,
          record: settingUp,
          ...(container?.running ? { containerId: container.id } : {}),
          notifyRelay: record.phase === "ready" && container?.running === true
        });
        record = await reconcileNativeWorkspace(runner, options, state, settingUp, setStage);
        return setupWorkspaceLocked(runner, options, state, record, profilesChanged, false, setStage, setErrorStage);
      } finally {
        await runWorkspaceLifecycleStage("setup", "workspace setup lock release", release);
      }
    } finally {
      await runWorkspaceLifecycleStage("setup", "Project lock release", releaseProject);
    }
  });
}

export async function setupWorkspaceLocked(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  state: LifecycleState,
  initialRecord: WorkspaceRecord,
  profilesChanged = false,
  forceRecreate = false,
  setStage: SetWorkspaceLifecycleStage = () => undefined,
  setErrorStage: SetWorkspaceLifecycleErrorStage = () => undefined
): Promise<WorkspaceRecord> {
  let record = initialRecord;
  setStage("workspace container readiness");
  const containerId = await assertContainerRunning(runner, options.stateRoot, record);
  setStage("protected root validation");
  await assertRootSnapshot(options.stateRoot, record);
  const startedAt = new Date().toISOString();
  record = {
    ...record,
    phase: "setting-up",
    lastSetup: { startedAt },
    updatedAt: startedAt
  };
  delete record.error;

  if (initialRecord.phase === "ready") {
    await notifyRecommendedWorkspaceRelayPhase(runner, record, containerId, "setting-up");
  }
  setStage("setup-state publication");
  await state.writeWorkspace(record);

  if (record.environment === "recommended") {
    setStage("recommended workspace agent readiness");
    let relayStarted = false;
    try {
      await reconcileWorkspaceAgent(runner, {
        options,
        record,
        outerContainerId: containerId,
        relayStarted: () => { relayStarted = true; }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failed = {
        ...record,
        phase: "setup-error" as const,
        lastSetup: { startedAt, completedAt: new Date().toISOString(), exitCode: 1, error: detail },
        error: detail,
        updatedAt: new Date().toISOString()
      };
      setErrorStage("recommended workspace agent readiness");
      setStage("setup-error publication");
      let notificationError: unknown;
      if (relayStarted) {
        try {
          await notifyRecommendedWorkspaceRelayPhase(runner, failed, containerId, "setup-error");
        } catch (phaseError) {
          notificationError = phaseError;
        }
      }
      try {
        await state.writeWorkspace(failed);
      } catch (publicationError) {
        const secondary = notificationError === undefined
          ? publicationError
          : combineWorkspaceLifecycleFailures(notificationError, publicationError);
        throw combineWorkspaceLifecycleFailures(error, secondary);
      }
      if (notificationError !== undefined) throw combineWorkspaceLifecycleFailures(error, notificationError);
      throw error;
    }
  }

  setStage("Project setup");
  const exitCode = await runProjectSetup(
    runner,
    { ...record, containerName: containerId },
    profilesChanged,
    forceRecreate
  );
  const completedAt = new Date().toISOString();
  if (exitCode !== 0) {
    const setupError = `project setup exited with ${exitCode}`;
    const setupFailure = new UserError(setupError);
    record = {
      ...record,
      phase: "setup-error",
      lastSetup: { startedAt, completedAt, exitCode, error: setupError },
      updatedAt: completedAt,
      error: setupError
    };
    setErrorStage("Project setup");
    setStage("setup-error publication");
    try {
      await notifyRecommendedWorkspaceRelayPhase(runner, record, containerId, "setup-error");
      await state.writeWorkspace(record);
    } catch (publicationError) {
      throw combineWorkspaceLifecycleFailures(setupFailure, publicationError);
    }
    throw setupFailure;
  }
  record = {
    ...record,
    phase: "ready",
    lastSetup: { startedAt, completedAt, exitCode: 0 },
    updatedAt: completedAt
  };
  delete record.error;
  setStage("ready-state publication");
  try {
    await state.writeWorkspace(record);
  } catch (error) {
    setErrorStage("ready-state publication");
    setStage("setup-error publication");
    const failed = {
      ...record,
      phase: "setup-error" as const,
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString()
    };
    let notificationError: unknown;
    try {
      await notifyRecommendedWorkspaceRelayPhase(runner, record, containerId, "setup-error");
    } catch (phaseError) {
      notificationError = phaseError;
    }
    try {
      await state.writeWorkspace(failed);
    } catch (publicationError) {
      const secondary = notificationError === undefined
        ? publicationError
        : combineWorkspaceLifecycleFailures(notificationError, publicationError);
      throw combineWorkspaceLifecycleFailures(error, secondary);
    }
    if (notificationError !== undefined) throw combineWorkspaceLifecycleFailures(error, notificationError);
    throw error;
  }
  try {
    await notifyRecommendedWorkspaceRelayPhase(runner, record, containerId, "ready");
  } catch (error) {
    setErrorStage("ready-state publication");
    setStage("setup-error publication");
    const failed = {
      ...record,
      phase: "setup-error" as const,
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString()
    };
    try {
      await state.writeWorkspace(failed);
    } catch (publicationError) {
      throw combineWorkspaceLifecycleFailures(error, publicationError);
    }
    throw error;
  }
  return record;
}

export async function reconcileNativeWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  state: LifecycleState,
  initialRecord: WorkspaceRecord,
  setStage: SetWorkspaceLifecycleStage
): Promise<WorkspaceRecord> {
  const release = await state.acquireWorkspaceLock(initialRecord.name);
  let record = await readWorkspaceForOperation(state, initialRecord.name);
  let relayContainerId: string | undefined;
  try {
    if (record.workspaceId !== initialRecord.workspaceId) {
      throw new UserError("native workspace identity changed");
    }
    const inspected = await inspectWorkspaceContainer(runner, record);
    if (inspected?.running) relayContainerId = inspected.id;
    const containerId = await reconcileContainer(runner, options, record, {
      username: "dim", token: "", userName: record.gitUserName, userEmail: record.gitUserEmail
    });
    relayContainerId = containerId;
    await installHostInputHelper(runner, { ...record, containerName: containerId });
    await writeProjectManifest(runner, { ...record, containerName: containerId });
    record = { ...record, updatedAt: new Date().toISOString() };
    await state.writeWorkspace(record);
    return record;
  } catch (error) {
    const detail = `workspace reconciliation: ${error instanceof Error ? error.message : String(error)}`;
    record = { ...record, phase: "error", error: detail, updatedAt: new Date().toISOString() };
    try {
      await publishWorkspacePhase({
        runner,
        state,
        record,
        ...(relayContainerId === undefined ? {} : { containerId: relayContainerId }),
        notifyRelay: relayContainerId !== undefined
      });
    } catch (publicationError) {
      throw combineWorkspaceLifecycleFailures(error, publicationError);
    }
    throw new UserError(detail, { cause: error });
  } finally {
    setStage("workspace reconciliation lock release");
    await release();
    setStage("workspace reconciliation");
  }
}
