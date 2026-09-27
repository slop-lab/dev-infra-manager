import { describe, expect, it } from "vitest";
import { finalizeRun, markRunFatal } from "../../.dim/qemu-run-finalization.mjs";

function runState() {
  return {
    abort: new AbortController(), cancelled: true, childClosed: undefined, closeResult: undefined,
    listeners: new Set<{ end: () => void }>(), preserveEvidence: false, snapshotRoot: "/unused/run-snapshot",
    state: { status: "running" }, work: undefined,
  };
}

describe("QEMU run finalization cleanup ownership", () => {
  it("finishes already-owned snapshot cleanup but does not release after a fatal upgrade", async () => {
    // Given
    const run = runState();
    const cleanupStarted = Promise.withResolvers<void>();
    const cleanupRelease = Promise.withResolvers<void>();
    let released = false;

    // When
    const finalizing = finalizeRun(run, "cancelled", {
      releaseRun: () => { released = true; },
      removeSnapshot: async () => {
        cleanupStarted.resolve();
        await cleanupRelease.promise;
      },
    });
    const first = await Promise.race([
      cleanupStarted.promise.then(() => "cleanup" as const),
      finalizing.then(() => "finalized" as const),
    ]);

    // Then
    expect.soft(first, "ordinary cleanup must own deletion before yielding").toBe("cleanup");
    markRunFatal(run);
    cleanupRelease.resolve();
    await finalizing;
    expect.soft(run.snapshotRoot).toBeUndefined();
    expect(released, "fatal upgrade must retain the remaining run evidence").toBe(false);
  });

  it("skips snapshot cleanup when fatal shutdown owns finalization first", async () => {
    // Given
    const run = runState();
    let removed = false;
    let released = false;
    markRunFatal(run);

    // When
    await finalizeRun(run, "cancelled", {
      releaseRun: () => { released = true; },
      removeSnapshot: async () => { removed = true; },
    });

    // Then
    expect.soft(removed).toBe(false);
    expect.soft(released).toBe(false);
    expect(run.snapshotRoot).toBe("/unused/run-snapshot");
  });
});