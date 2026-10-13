import { UserError } from "./errors.js";
import { ensureGitea, giteaNestedBaseUrl } from "./gitea.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type {
  LifecycleOptions,
  ProjectRecord,
  WorkspaceRecord
} from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";
import { writeProjectManifest } from "./workspaceRepositorySnapshot.js";
import { assertContainerRunning, reconcileContainer } from "./workspaceContainer.js";
import { workspaceGitEnvironment, workspaceRootSnapshotPath } from "./workspaceLifecycleTypes.js";
import {
  combineWorkspaceLifecycleFailures,
  runWorkspaceLifecycle,
  runWorkspaceLifecycleStage,
  type SetWorkspaceLifecycleErrorStage, type SetWorkspaceLifecycleStage
} from "./workspaceLifecycleError.js";
import { assertRootSnapshot, installHostInputHelper, runProjectSetup } from "./workspaceProjectCommands.js";
import { applySelectedRoot } from "./workspacePublication.js";
import { inspectWorkspaceContainer } from "./workspaceResourceOwnership.js";
import { assertWorkspaceLifecycleActive } from "./workspaceRecord.js";
import { readWorkspaceForOperation } from "./workspaceValidation.js";
import { notifyRecommendedWorkspaceRelayPhase, reconcileWorkspaceAgent } from "./workspaceAgentLifecycle.js";
import { publishWorkspacePhase } from "./workspacePhasePublication.js";

type ReconcileProjectContainerInput = {
  readonly runner: StreamingCommandRunner;
  readonly options: LifecycleOptions;
  readonly state: LifecycleState;
  readonly record: WorkspaceRecord;
  readonly project: ProjectRecord;
  readonly repo: ProjectRecord["repositories"][number];
  readonly setStage: SetWorkspaceLifecycleStage;
};

export async function setupWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  profilesChanged = false
): Promise<WorkspaceRecord> {
  return runWorkspaceLifecycle("setup", async (setStage, setErrorStage) => {
    const workspaceName = validateLifecycleName(name, "workspace");
    const state = new LifecycleState(options.stateRoot);
    setStage("workspace state loading");
    const initialRecord = await readWorkspaceForOperation(state, workspaceName, options.giteaConnection);
    assertWorkspaceLifecycleActive(initialRecord);
    setStage("Project lock acquisition");
    const releaseProject = await state.acquireProjectLock(initialRecord.projectName);
    try {
      setStage("workspace setup lock acquisition");
      const release = await state.acquireWorkspaceSetupLock(workspaceName);
      try {
        setStage("workspace state loading");
        let record = await readWorkspaceForOperation(state, workspaceName, options.giteaConnection);
        assertWorkspaceLifecycleActive(record);
        if (record.projectName !== initialRecord.projectName || record.projectId !== initialRecord.projectId) {
          throw new UserError(`project '${record.projectName}' identity changed`);
        }
        setStage("protected root validation");
        await assertRootSnapshot(options.stateRoot, record);
        if (record.schemaVersion === 9) {
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
          record = settingUp;
          record = await reconcileNativeWorkspace(runner, options, state, record, setStage);
          return setupWorkspaceLocked(runner, options, state, record, profilesChanged, false, setStage, setErrorStage);
        }
        if (record.phase === "setting-up" || record.phase === "setup-error" || record.phase === "error") {
          setStage("Project state loading");
          const project = await state.readProject(record.projectName);
          if (project.id !== record.projectId) throw new UserError(`project '${record.projectName}' identity changed`);
          const repo = project.repositories.find((candidate) => candidate.alias === record.rootRepositoryAlias);
          if (repo === undefined) throw new UserError(`project '${project.name}' root repository is missing`);
          setStage("workspace reconciliation");
          const reconciled = await reconcileProjectContainer({ runner, options, state, record, project, repo, setStage });
          record = reconciled.record;
          const containerId = reconciled.containerId;
          setStage("protected root publication");
          record = await applySelectedRoot({
            runner,
            state,
            record,
            containerId,
            target: {
              rootRef: record.rootRef,
              rootCommit: record.rootCommit,
              rootSnapshotPath: workspaceRootSnapshotPath(options.stateRoot, record)
            }
          });
        }
        return await setupWorkspaceLocked(runner, options, state, record, profilesChanged, false, setStage, setErrorStage);
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

export async function reconcileProject(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  state: LifecycleState,
  initialRecord: WorkspaceRecord,
  project: ProjectRecord,
  repo: ProjectRecord["repositories"][number],
  setStage: SetWorkspaceLifecycleStage
): Promise<WorkspaceRecord> {
  const reconciled = await reconcileProjectContainer({
    runner, options, state, record: initialRecord, project, repo, setStage
  });
  let record = reconciled.record;
  try {
    setStage("Project manifest publication");
    await writeProjectManifest(runner, { ...record, containerName: reconciled.containerId });
    record = { ...record, updatedAt: new Date().toISOString() };
    setStage("workspace state publication");
    await state.writeWorkspace(record);
    return record;
  } catch (error) {
    record = {
      ...record,
      phase: "error",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString()
    };
    try {
      await publishWorkspacePhase({
        runner,
        state,
        record,
        containerId: reconciled.containerId,
        notifyRelay: true
      });
    } catch (publicationError) {
      throw combineWorkspaceLifecycleFailures(error, publicationError);
    }
    throw error;
  }
}

export async function reconcileProjectContainer(
  input: ReconcileProjectContainerInput
): Promise<{ readonly record: WorkspaceRecord; readonly containerId: string }> {
  if (input.record.schemaVersion === 9) {
    throw new UserError("native workspace reconciliation is not initialized");
  }
  const release = await input.state.acquireWorkspaceLock(input.record.name);
  let record = await readWorkspaceForOperation(input.state, input.record.name, input.options.giteaConnection);
  let relayContainerId: string | undefined;
  if (record.schemaVersion !== 8) throw new UserError("native workspace reconciliation is not initialized");
  let stage = "container inspection";
  try {
    const inspected = await inspectWorkspaceContainer(input.runner, record);
    if (inspected?.running) relayContainerId = inspected.id;
    stage = "managed Git reconciliation";
    const credentials = await ensureGitea(input.runner, input.options);
    stage = "managed Git address discovery";
    const gitBaseUrl = `${await giteaNestedBaseUrl(input.runner, credentials)}/${input.project.gitNamespace}`;
    record = {
      ...record,
      projectName: input.project.name,
      rootRepositoryAlias: input.repo.alias,
      gitBaseUrl,
      hostAliases: credentials.kind === "managed"
        ? { "dim-gitea": [new URL(gitBaseUrl).hostname] }
        : {}
    };
    stage = "workspace metadata publication";
    await input.state.writeWorkspace(record);
    stage = "workspace container reconciliation";
    const containerId = await reconcileContainer(
      input.runner,
      input.options,
      record,
      workspaceGitEnvironment(record, credentials)
    );
    relayContainerId = containerId;
    stage = "host-input helper installation";
    await installHostInputHelper(input.runner, { ...record, containerName: containerId });
    return { record, containerId };
  } catch (error) {
    const detail = `workspace reconciliation at ${stage}: ${error instanceof Error ? error.message : String(error)}`;
    record = {
      ...record,
      phase: "error",
      error: detail,
      updatedAt: new Date().toISOString()
    };
    try {
      await publishWorkspacePhase({
        runner: input.runner,
        state: input.state,
        record,
        ...(relayContainerId === undefined ? {} : { containerId: relayContainerId }),
        notifyRelay: relayContainerId !== undefined
      });
    } catch (publicationError) {
      throw combineWorkspaceLifecycleFailures(error, publicationError);
    }
    throw new UserError(detail, { cause: error });
  } finally {
    input.setStage("workspace reconciliation lock release");
    await release();
    input.setStage("workspace reconciliation");
  }
}

export async function reconcileNativeWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  state: LifecycleState,
  initialRecord: WorkspaceRecord,
  setStage: SetWorkspaceLifecycleStage
): Promise<WorkspaceRecord> {
  if (initialRecord.schemaVersion !== 9) throw new UserError("native workspace record is required");
  const release = await state.acquireWorkspaceLock(initialRecord.name);
  let record = await readWorkspaceForOperation(state, initialRecord.name, options.giteaConnection);
  let relayContainerId: string | undefined;
  try {
    if (record.schemaVersion !== 9 || record.workspaceId !== initialRecord.workspaceId) {
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
