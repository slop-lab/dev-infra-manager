import { rm } from "node:fs/promises";
import { stopProcessGroup } from "./qemu-process-group.mjs";

export function requestRunFinalization(run, reason) {
  if (!run.finalizationRequested) {
    run.finalizationRequested = true;
    run.resolveFinalization(reason);
  }
  return run.completion;
}

export async function finalizeRun(run, reason, { releaseRun, removeSnapshot = rm }) {
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
    if (run.snapshotRoot) await removeSnapshot(run.snapshotRoot, { recursive: true, force: true });
    run.snapshotRoot = undefined;
    if (run.preserveEvidence) return;
    releaseRun(run, reason);
  } finally {
    for (const listener of run.listeners) listener.end();
    run.listeners.clear();
  }
}

export function markRunFatal(run) {
  if (!run) return;
  run.preserveEvidence = true;
  run.abort.abort();
  run.request?.destroy();
  run.response?.destroy();
}

export async function quiesceRunPreservingEvidence(run) {
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
