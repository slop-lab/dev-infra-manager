import { UserError } from "./errors.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import type { WorkspaceDiscardHook } from "./plugin.js";
import type { StreamingCommandRunner } from "./types.js";
import { protectedRootSnapshotPath } from "./protectedRootSnapshot.js";
import { waitForInnerDocker } from "./workspaceContainer.js";
import { runProjectTeardown } from "./workspaceProjectCommands.js";
import {
  inspectWorkspaceContainer,
  inspectWorkspaceVolume,
  isMissingContainer,
  isMissingVolume
} from "./workspaceResourceOwnership.js";

export async function discardWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  keepVolume = false,
  hooks: readonly WorkspaceDiscardHook[] = []
): Promise<void> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    const record = await state.readWorkspace(workspaceName);
    for (const hook of hooks) {
      await hook.beforeDiscard({
        workspaceId: `${record.projectId}:${record.name}`,
        workspaceName: record.name,
        projectId: record.projectId,
        projectName: record.projectName,
        stateRoot: options.stateRoot
      });
    }
    const container = await inspectWorkspaceContainer(runner, record);
    const volume = await inspectWorkspaceVolume(runner, record);
    if (container !== undefined) {
      if (container.rootSnapshotPath !== protectedRootSnapshotPath(options.stateRoot, record.projectId, record.rootCommit)) {
        throw new UserError(`workspace '${record.name}' container root does not match its recorded immutable root`);
      }
      const inspectedRecord = { ...record, containerName: container.id };
      if (!container.running) {
        const started = await runner.run("docker", ["start", container.id]);
        if (started.exitCode !== 0) throw new UserError(`failed to start workspace '${record.name}' for teardown`);
        await waitForInnerDocker(runner, container.id);
      }
      await runProjectTeardown(runner, options.stateRoot, inspectedRecord, keepVolume);
      const removed = await runner.run("docker", ["container", "rm", "--force", container.id]);
      if (removed.exitCode !== 0 && !isMissingContainer(removed.stderr, container.id)) {
        throw new UserError(`failed to remove workspace container: ${removed.stderr.trim()}`);
      }
    }
    if (!keepVolume && volume !== undefined) {
      const removalTarget = await inspectWorkspaceVolume(runner, record);
      if (removalTarget !== undefined) {
        const removed = await runner.run("docker", ["volume", "rm", removalTarget]);
        if (removed.exitCode !== 0 && !isMissingVolume(removed.stderr, removalTarget)) {
          throw new UserError(`failed to remove workspace Docker volume: ${removed.stderr.trim()}`);
        }
      }
    }
    await state.removeWorkspace(workspaceName);
    await state.removeWorkspaceGrant(workspaceName);
    await state.removeAgentGrant(workspaceName);
  } finally {
    await release();
  }
}
