import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionCapacityObservation, ExecutionCapacityPlan } from "@slop-lab/dim-contracts-execution";

export interface ExecutionCapacityAdapter {
  observe(workerId: string): Promise<ExecutionCapacityObservation & { readonly instance?: string }>;
  start(workerId: string): Promise<void>;
  /** Compare actual owned instance identity and local journals immediately before aborting its loop. */
  stop(workerId: string, expectedInstance: string): Promise<void>;
}
export interface ExecutionCapacityClient {
  readonly generationId: string; readonly providerId: string;
  reconcile(input: { schemaVersion: 1; observations: ExecutionCapacityObservation[]; drain: boolean }): Promise<ExecutionCapacityPlan>;
  authorizeStop(workerId: string, revision: number): Promise<void>;
}
/** One serialized step; an old plan cannot race another local start or stop. */
export async function reconcileExecutionCapacity(input: {
  readonly workerIds: readonly string[]; readonly client: ExecutionCapacityClient;
  readonly adapter: ExecutionCapacityAdapter; readonly drain: boolean; readonly signal?: AbortSignal; readonly report?: (message: string) => void;
}): Promise<void> {
  const observed = await Promise.all(input.workerIds.map(id => input.adapter.observe(id)));
  const plan = await input.client.reconcile({ schemaVersion: 1, drain: input.drain,
    observations: observed.map(({ workerId, state, clean }) => ({ workerId, state, clean })) });
  if (plan.generationId !== input.client.generationId || plan.providerId !== input.client.providerId
    || plan.workers.length !== input.workerIds.length || new Set(plan.workers.map(w => w.workerId)).size !== input.workerIds.length
    || plan.workers.some(w => !input.workerIds.includes(w.workerId))) throw new Error("capacity plan does not match the owned pool");
  for (const decision of plan.workers) {
    if (decision.action === "start" && !input.drain && !input.signal?.aborted) {
      await input.adapter.start(decision.workerId); input.report?.(`Capacity worker ${decision.workerId}: starting.`);
    }
    if (decision.action === "stop") {
      const before = observed.find(o => o.workerId === decision.workerId)!;
      if (!before.clean || !before.instance) continue;
      await input.client.authorizeStop(decision.workerId, decision.revision);
      await input.adapter.stop(decision.workerId, before.instance); input.report?.(`Capacity worker ${decision.workerId}: stopped after drain and cleanup.`);
    }
  }
}
export async function runExecutionCapacityReconciler(input: {
  readonly workerIds: readonly string[]; readonly client: ExecutionCapacityClient; readonly adapter: ExecutionCapacityAdapter;
  readonly signal: AbortSignal; readonly pollMilliseconds: number; readonly report?: (message: string) => void;
}): Promise<void> {
  let unavailable = false;
  for (;;) {
    const draining = input.signal.aborted;
    try {
      await reconcileExecutionCapacity({ ...input, drain: draining });
      if (draining && (await Promise.all(input.workerIds.map(id => input.adapter.observe(id)))).every(o => o.state !== "running" && o.clean)) return;
      unavailable = false;
    } catch { if (!unavailable) input.report?.("Capacity reconciliation unavailable; no new worker action was authorized."); unavailable = true; }
    // Shutdown drains through the same authority and local cleanup fences; it never kills occupied loops.
    await delay(input.pollMilliseconds);
  }
}
