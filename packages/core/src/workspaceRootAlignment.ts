import { UserError } from "./errors.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";
import { assertContainerRunning } from "./workspaceContainer.js";
import { commandError, projectCommand } from "./workspaceProjectCommands.js";

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
    const containerId = await assertContainerRunning(runner, record);
    const runtimeRecord = { ...record, containerName: containerId };
    const status = await projectCommand(runner, runtimeRecord, ["git", "status", "--porcelain"]);
    if (status.exitCode !== 0) throw commandError("inspect project Git status", status);
    if (!reset && status.stdout.trim()) {
      throw new UserError(`workspace '${workspaceName}' has uncommitted project changes`);
    }
    const fetch = await projectCommand(runner, runtimeRecord, ["git", "fetch", "origin", record.rootRef]);
    if (fetch.exitCode !== 0) throw commandError(`fetch root ref '${record.rootRef}'`, fetch);
    if (record.rootRef.startsWith("refs/heads/")) {
      const branch = record.rootRef.slice("refs/heads/".length);
      const align = await projectCommand(
        runner,
        runtimeRecord,
        reset
          ? ["git", "switch", "--discard-changes", "--force-create", branch, "FETCH_HEAD"]
          : ["git", "switch", branch]
      );
      if (align.exitCode !== 0) throw commandError(`switch to root branch '${branch}'`, align);
      if (!reset) {
        const merge = await projectCommand(runner, runtimeRecord, ["git", "merge", "--ff-only", "FETCH_HEAD"]);
        if (merge.exitCode !== 0) throw commandError(`fast-forward root ref '${record.rootRef}'`, merge);
      }
    } else {
      const checkout = await projectCommand(
        runner,
        runtimeRecord,
        reset
          ? ["git", "switch", "--discard-changes", "--detach", "FETCH_HEAD"]
          : ["git", "switch", "--detach", "FETCH_HEAD"]
      );
      if (checkout.exitCode !== 0) throw commandError(`check out root ref '${record.rootRef}'`, checkout);
    }
    if (reset) {
      const clean = await projectCommand(runner, runtimeRecord, ["git", "clean", "-fd"]);
      if (clean.exitCode !== 0) throw commandError("clean reset project checkout", clean);
    }
    return record;
  } finally {
    await release();
  }
}
