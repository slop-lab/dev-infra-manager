import { UserError } from "@slop-lab/dim-core";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import { requireNativeControlPlaneConnection } from "./lifecycleOptions.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import type { WorkspaceDiscardHook } from "./plugin.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";
import { workspaceRootSnapshotPath } from "./workspaceLifecycleTypes.js";
import { waitForInnerDocker } from "./workspaceContainer.js";
import { runProjectTeardown } from "./workspaceProjectCommands.js";
import {
  inspectWorkspaceContainer,
  inspectWorkspaceVolume,
  isMissingContainer,
  isMissingVolume
} from "./workspaceResourceOwnership.js";
import { readWorkspaceForOperation } from "./workspaceValidation.js";
import { discardWorkspaceAgentResources, notifyRecommendedWorkspaceRelayPhase } from "./workspaceAgentLifecycle.js";

export async function discardWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  keepVolume = false,
  hooks: readonly WorkspaceDiscardHook[] = []
): Promise<void> {
  requireNativeControlPlaneConnection(options);
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    const releaseAuthority = await state.acquireWorkspaceAuthorityLock(workspaceName);
    let record: WorkspaceRecord;
    try {
      record = await readWorkspaceForOperation(state, workspaceName);
      if (keepVolume && record.environment === "recommended") {
        throw new UserError(
          `recommended workspace '${record.name}' does not support --keep-volume because its private home, checkout, and Docker volumes are identity-bound; preserve data by leaving the workspace intact or copying it before discard`
        );
      }
      const discarding = { ...record, phase: "discarding" as const, updatedAt: new Date().toISOString() };
      let container;
      try {
        container = await inspectWorkspaceContainer(runner, record);
      } catch (error) {
        await state.writeWorkspace(discarding);
        throw error;
      }
      if (container !== undefined
        && container.rootSnapshotPath !== workspaceRootSnapshotPath(options.stateRoot, record)) {
        throw new UserError(`workspace '${record.name}' container root does not match its recorded immutable root`);
      }
      if (container?.running) {
        await notifyRecommendedWorkspaceRelayPhase(runner, record, container.id, "discarding");
      }
      await state.writeWorkspace(discarding);
      await state.removeWorkspaceGrant(record);
      await state.removeAgentGrant(record);
      await state.removeNativeGitGrant(record);
    } finally {
      await releaseAuthority();
    }
    for (const hook of hooks) {
      await hook.beforeDiscard({
        workspaceId: record.workspaceId,
        workspaceName: record.name,
        projectId: record.projectId,
        projectName: record.projectName,
        stateRoot: options.stateRoot
      });
    }
    const container = await inspectWorkspaceContainer(runner, record);
    const volume = await inspectWorkspaceVolume(runner, record);
    const environment = record.environment ?? "custom";
    if (environment === "recommended") {
      await discardWorkspaceAgentResources(runner, record, keepVolume, container?.id ?? null);
    }
    if (container !== undefined) {
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
  } finally {
    await release();
  }
}
