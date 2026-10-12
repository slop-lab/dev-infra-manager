import {
  reconcileReadyHostManagedGit as reconcileManagedGit,
  startHost as recoverHost
} from "./hostRecovery.js";
import { shutdownHost as stopHost } from "./hostShutdown.js";
import { UserError } from "./errors.js";
import { LifecycleState } from "./lifecycleState.js";
import type { HostLifecycleRecord, LifecycleOptions } from "./lifecycleTypes.js";

export const shutdownHost = stopHost;
export const startHost = recoverHost;
export const reconcileReadyHostManagedGit = reconcileManagedGit;

export async function hostLifecycleStatus(options: LifecycleOptions): Promise<HostLifecycleRecord> {
  const state = new LifecycleState(options.stateRoot);
  const record = await state.readHostLifecycle() ?? {
    schemaVersion: 2,
    phase: "ready",
    resumeWorkspaces: [],
    restartCiRunners: [],
    resumeManagedContainers: [],
    updatedAt: new Date(0).toISOString()
  };
  if (options.nativeControlPlaneConnection !== undefined) {
    if (record.restartCiRunners.length > 0 || record.resumeManagedContainers.length > 0) {
      throw new UserError("native host lifecycle state contains predecessor recovery targets");
    }
    await state.listWorkspaces(9);
  }
  return record;
}
