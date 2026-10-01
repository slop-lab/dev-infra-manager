import { UserError } from "./errors.js";
import { hostLifecycleStatus } from "./hostLifecycle.js";
import { LifecycleState } from "./lifecycleState.js";
import type { HostLifecycleRecord, LifecycleOptions } from "./lifecycleTypes.js";

export class HostNotReadyError extends UserError {
  readonly name = "HostNotReadyError";

  constructor(readonly phase: HostLifecycleRecord["phase"]) {
    super(`DIM host is ${phase}; run dim host start`);
  }
}

export async function withHostAdminAdmission<T>(
  lifecycle: LifecycleOptions,
  execute: () => Promise<T>
): Promise<T> {
  const release = await new LifecycleState(lifecycle.stateRoot).acquireHostLifecycleLock();
  try {
    const host = await hostLifecycleStatus(lifecycle);
    if (host.phase !== "ready") throw new HostNotReadyError(host.phase);
    return await execute();
  } finally {
    await release();
  }
}

export async function withHostRuntimeAdmission<T>(
  lifecycle: LifecycleOptions,
  execute: () => Promise<T>
): Promise<T> {
  const release = await new LifecycleState(lifecycle.stateRoot).acquireHostLifecycleLock();
  try {
    const host = await hostLifecycleStatus(lifecycle);
    if (host.phase !== "ready") throw new HostNotReadyError(host.phase);
  } finally {
    await release();
  }
  return await execute();
}
