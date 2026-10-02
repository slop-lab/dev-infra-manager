import {
  reconcileReadyHostManagedGit as reconcileManagedGit,
  startHost as recoverHost
} from "./hostRecovery.js";
import { shutdownHost as stopHost } from "./hostShutdown.js";
import { LifecycleState } from "./lifecycleState.js";
import type { HostLifecycleRecord, LifecycleOptions } from "./lifecycleTypes.js";

export const shutdownHost = stopHost;
export const startHost = recoverHost;
export const reconcileReadyHostManagedGit = reconcileManagedGit;

export async function hostLifecycleStatus(options: LifecycleOptions): Promise<HostLifecycleRecord> {
  return await new LifecycleState(options.stateRoot).readHostLifecycle() ?? {
    schemaVersion: 2,
    phase: "ready",
    resumeWorkspaces: [],
    restartCiRunners: [],
    resumeManagedContainers: [],
    updatedAt: new Date(0).toISOString()
  };
}
