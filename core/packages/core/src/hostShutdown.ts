import { UserError } from "./errors.js";
import { requireNativeControlPlaneConnection } from "./lifecycleOptions.js";
import { LifecycleState } from "./lifecycleState.js";
import type { HostLifecycleRecord, LifecycleOptions } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";
import { stopWorkspaceForHostShutdown } from "./workspaceLifecycle.js";

export async function shutdownHost(
  runner: StreamingCommandRunner,
  options: LifecycleOptions
): Promise<HostLifecycleRecord> {
  requireNativeControlPlaneConnection(options);
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireHostLifecycleLock();
  try {
    const current = await state.readHostLifecycle();
    if (current && current.phase !== "ready") {
      throw new UserError(`DIM host is already ${current.phase}; run dim host start to recover it`);
    }
    const workspaces = await state.listWorkspaces();
    const resumeWorkspaces = workspaces.filter((workspace) => workspace.phase === "ready")
      .map((workspace) => workspace.name);
    const shutdownWorkspaces = workspaces
      .filter((workspace) => workspace.phase === "ready" || workspace.phase === "discarding")
      .map((workspace) => workspace.name);
    let record: HostLifecycleRecord = {
      schemaVersion: 2,
      phase: "stopping",
      resumeWorkspaces,
      updatedAt: new Date().toISOString()
    };
    await state.writeHostLifecycle(record);
    const errors: string[] = [];
    for (const workspace of shutdownWorkspaces) {
      try {
        await stopWorkspaceForHostShutdown(runner, options, workspace);
      } catch (error) {
        errors.push(`stop workspace '${workspace}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    record = {
      ...record,
      phase: errors.length === 0 ? "stopped" : "error",
      updatedAt: new Date().toISOString(),
      ...(errors.length === 0 ? {} : { error: errors.join("; ") })
    };
    await state.writeHostLifecycle(record);
    if (errors.length > 0) throw new UserError(errors.join("; "));
    return record;
  } finally {
    await release();
  }
}
