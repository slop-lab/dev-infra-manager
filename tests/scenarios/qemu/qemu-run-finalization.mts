import { rm } from "node:fs/promises";
import { stopProcessGroup } from "./qemu-process-group.mts";

export function requestRunFinalization(run: Pick<import("./qemu-types.js").Run,"completion"|"finalizationRequested"|"resolveFinalization">, reason: import("./qemu-types.js").FinalizationReason) {
  if (run.completion === undefined) throw new Error("run completion is unavailable");
  if (!run.finalizationRequested) {
    run.finalizationRequested = true;
    run.resolveFinalization(reason);
  }
  return run.completion;
}

export async function finalizeRun<TRun extends import("./qemu-types.js").FinalizableRun>(run: TRun, reason: import("./qemu-types.js").FinalizationReason, { releaseRun, removeSnapshot = rm }: {releaseRun(run:TRun,reason:import("./qemu-types.js").FinalizationReason):void,removeSnapshot?:typeof rm}) {
  try {
    if (run.work) {
      try { await run.work; } catch (error) {
        if (reason !== "rejected" && !run.abort.signal.aborted) throw error;
      }
    }
    if (run.childClosed) {
      await stopProcessGroup(run);
      await run.childClosed;
    }
    run.cleanupOwner = run.preserveEvidence ? "fatal" : "ordinary";
    if (run.cleanupOwner === "fatal") return;
    if (reason !== "rejected") {
      run.state = {
        ...run.state,
        status: run.cancelled || reason === "cancelled" ? "cancelled" : run.closeResult?.exitCode === 0 ? "success" : "failure",
        exitCode: run.closeResult?.exitCode ?? undefined, signal: run.closeResult?.signal ?? undefined,
        completedAt: new Date().toISOString()
      };
    }
    if (run.handoffRoot) await removeSnapshot(run.handoffRoot, { recursive: true, force: true });
    run.handoffRoot = undefined;
    if (run.snapshotRoot) await removeSnapshot(run.snapshotRoot, { recursive: true, force: true });
    run.snapshotRoot = undefined;
    if (run.preserveEvidence) return;
    releaseRun(run, reason);
  } finally {
    for (const listener of run.listeners) listener.end();
    run.listeners.clear();
  }
}

export function markRunFatal(run: import("./qemu-types.js").FatalRun | undefined) {
  if (!run) return;
  run.preserveEvidence = true;
  run.abort.abort();
  run.request?.destroy();
  run.response?.destroy();
}

export async function quiesceRunPreservingEvidence(run: import("./qemu-types.js").QuiesceRun | undefined) {
  markRunFatal(run);
  if (!run) return;
  if (run.finalizationRequested) {
    await run.completion;
    return;
  }
  if (run.work) {
    try { await run.work; } catch (error) {
      if (!run.abort.signal.aborted) throw error;
    }
  }
  if (run.childClosed) {
    await stopProcessGroup(run);
    await run.childClosed;
  }
}
