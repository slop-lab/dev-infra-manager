import { UserError } from "./errors.js";
import { ensureGitea, giteaNestedBaseUrl } from "./gitea.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type {
  LifecycleOptions,
  ProjectRecord,
  WorkspaceRecord
} from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";
import { protectedRootSnapshotPath } from "./protectedRootSnapshot.js";
import { writeProjectManifest } from "./workspaceRepositorySnapshot.js";
import { assertContainerRunning, reconcileContainer } from "./workspaceContainer.js";
import { workspaceGitEnvironment } from "./workspaceLifecycleTypes.js";
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
              rootSnapshotPath: protectedRootSnapshotPath(options.stateRoot, record.projectId, record.rootCommit)
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
  setStage("setup-state publication");
  await state.writeWorkspace(record);

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
  try {
    setStage("ready-state publication");
    await state.writeWorkspace(record);
  } catch (error) {
    setErrorStage("ready-state publication");
    setStage("setup-error publication");
    try {
      await state.writeWorkspace({
        ...record,
        phase: "setup-error",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      });
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
    await state.writeWorkspace(record);
    throw error;
  }
}

export async function reconcileProjectContainer(
  input: ReconcileProjectContainerInput
): Promise<{ readonly record: WorkspaceRecord; readonly containerId: string }> {
  const release = await input.state.acquireWorkspaceLock(input.record.name);
  let record = await readWorkspaceForOperation(input.state, input.record.name, input.options.giteaConnection);
  let stage = "container inspection";
  try {
    await inspectWorkspaceContainer(input.runner, record);
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
    await input.state.writeWorkspace(record);
    throw new UserError(detail, { cause: error });
  } finally {
    input.setStage("workspace reconciliation lock release");
    await release();
    input.setStage("workspace reconciliation");
  }
}
