import { UserError } from "./errors.js";
import { requireNativeControlPlaneConnection } from "./lifecycleOptions.js";
import { LifecycleState } from "./lifecycleState.js";
import type { HostLifecycleRecord, LifecycleOptions } from "./lifecycleTypes.js";
import { recoverNativeWorkspace } from "./nativeWorkspaceTransitions.js";
import type { StreamingCommandRunner } from "./types.js";

export async function startHost(
  runner: StreamingCommandRunner,
  options: LifecycleOptions
): Promise<HostLifecycleRecord> {
  requireNativeControlPlaneConnection(options);
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireHostLifecycleLock();
  try {
    const current = await state.readHostLifecycle();
    await state.listWorkspaces();
    if (!current || current.phase === "ready") return current ?? readyRecord();
    let record: HostLifecycleRecord = {
      ...current,
      phase: "starting",
      updatedAt: new Date().toISOString()
    };
    delete record.error;
    await state.writeHostLifecycle(record);
    try {
      for (const name of record.resumeWorkspaces) {
        const workspace = await state.readWorkspace(name);
        await recoverNativeWorkspace(runner, options, workspace);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record = { ...record, phase: "error", error: message, updatedAt: new Date().toISOString() };
      await state.writeHostLifecycle(record);
      throw new UserError(message);
    }
    record = { ...record, phase: "ready", resumeWorkspaces: [], updatedAt: new Date().toISOString() };
    await state.writeHostLifecycle(record);
    return record;
  } finally {
    await release();
  }
}

function readyRecord(): HostLifecycleRecord {
  return {
    schemaVersion: 2,
    phase: "ready",
    resumeWorkspaces: [],
    updatedAt: new Date(0).toISOString()
  };
}
