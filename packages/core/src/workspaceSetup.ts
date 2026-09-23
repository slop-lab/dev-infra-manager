import { UserError } from "./errors.js";
import { ensureGitea, giteaNestedBaseUrl } from "./gitea.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type {
  GiteaCredentials,
  LifecycleOptions,
  ProjectRecord,
  WorkspaceRecord
} from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";
import { writeProjectManifest } from "./workspaceRepositorySnapshot.js";
import { assertContainerRunning, reconcileContainer } from "./workspaceContainer.js";
import type { WorkspaceGitEnvironment } from "./workspaceLifecycleTypes.js";
import {
  assertRootSnapshot,
  installHostInputHelper,
  runProjectSetup
} from "./workspaceProjectCommands.js";
import { applySelectedRoot } from "./workspacePublication.js";

export async function setupWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  profilesChanged = false
): Promise<WorkspaceRecord> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const initialRecord = await state.readWorkspace(workspaceName);
  const releaseProject = await state.acquireProjectLock(initialRecord.projectName);
  try {
    const release = await state.acquireWorkspaceSetupLock(workspaceName);
    try {
      let record = await state.readWorkspace(workspaceName);
      if (record.projectName !== initialRecord.projectName || record.projectId !== initialRecord.projectId) {
        throw new UserError(`project '${record.projectName}' identity changed`);
      }
      await assertRootSnapshot(record);
      if (record.phase === "setting-up" || record.phase === "setup-error" || record.phase === "error") {
        const project = await state.readProject(record.projectName);
        if (project.id !== record.projectId) throw new UserError(`project '${record.projectName}' identity changed`);
        const containerId = await assertContainerRunning(runner, record);
        record = await applySelectedRoot({
          runner,
          state,
          record,
          containerId,
          target: {
            rootRef: record.rootRef,
            rootCommit: record.rootCommit,
            rootSnapshotPath: record.rootSnapshotPath
          }
        });
      }
      return await setupWorkspaceLocked(runner, options, state, record, profilesChanged);
    } finally {
      await release();
    }
  } finally {
    await releaseProject();
  }
}

export async function setupWorkspaceLocked(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  state: LifecycleState,
  initialRecord: WorkspaceRecord,
  profilesChanged = false,
  forceRecreate = false
): Promise<WorkspaceRecord> {
  let record = initialRecord;
  const containerId = await assertContainerRunning(runner, record);
  await assertRootSnapshot(record);
  const startedAt = new Date().toISOString();
  record = {
    ...record,
    phase: "setting-up",
    lastSetup: { startedAt },
    updatedAt: startedAt
  };
  delete record.error;
  await state.writeWorkspace(record);

  const exitCode = await runProjectSetup(
    runner,
    { ...record, containerName: containerId },
    profilesChanged,
    forceRecreate
  );
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
  try {
    await state.writeWorkspace(record);
  } catch (error) {
    await state.writeWorkspace({
      ...record,
      phase: "setup-error",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString()
    });
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
  repo: ProjectRecord["repositories"][number]
): Promise<WorkspaceRecord> {
  const release = await state.acquireWorkspaceLock(initialRecord.name);
  let record = await state.readWorkspace(initialRecord.name);
  try {
    try {
      const credentials = await ensureGitea(runner, options);
      const gitBaseUrl = `${await giteaNestedBaseUrl(runner)}/${project.gitNamespace}`;
      const giteaAddress = new URL(gitBaseUrl).hostname;
      record = {
        ...record,
        projectName: project.name,
        rootRepositoryAlias: repo.alias,
        gitBaseUrl,
        hostAliases: { "dim-gitea": [giteaAddress] }
      };
      await state.writeWorkspace(record);
      const containerId = await reconcileContainer(runner, options, record, gitEnvironment(record, credentials));
      const runtimeRecord = { ...record, containerName: containerId };
      await installHostInputHelper(runner, runtimeRecord);
       await writeProjectManifest(runner, runtimeRecord);
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

function gitEnvironment(record: WorkspaceRecord, credentials: GiteaCredentials): WorkspaceGitEnvironment {
  return {
    username: credentials.writerUsername,
    token: credentials.writerPassword,
    userName: record.gitUserName,
    userEmail: record.gitUserEmail
  };
}
