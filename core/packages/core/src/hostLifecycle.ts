import { startHost as recoverHost } from "./hostRecovery.js";
import { shutdownHost as stopHost } from "./hostShutdown.js";
import { LifecycleState } from "./lifecycleState.js";
import type { HostLifecycleRecord, LifecycleOptions } from "./lifecycleTypes.js";

export const shutdownHost = stopHost;
export const startHost = recoverHost;

export async function hostLifecycleStatus(options: LifecycleOptions): Promise<HostLifecycleRecord> {
  const state = new LifecycleState(options.stateRoot);
  const record = await state.readHostLifecycle() ?? {
    schemaVersion: 2,
    phase: "ready",
    resumeWorkspaces: [],
    updatedAt: new Date(0).toISOString()
  };
  await state.listWorkspaces();
  return record;
}
