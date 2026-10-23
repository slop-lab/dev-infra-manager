import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeProposalReconciliationLoop } from
  "../../../../packages/control-plane/plugins/git-review/src/native-proposal-reconciliation-loop.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("native proposal reconciliation loop", () => {
  it("fails closed after the bounded retry schedule is exhausted", async () => {
    // Given
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const failure = new Error("persistent proposal store failure");
    const started: number[] = [];
    const reconcile = vi.fn(async () => {
      started.push(Date.now());
      // Retry delays do not bound the time spent in Git/storage itself.
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      throw failure;
    });
    const unavailable = vi.fn();
    const loop = createNativeProposalReconciliationLoop({ reconcile, unavailable });

    // When
    loop.wake();
    await vi.runAllTimersAsync();
    loop.wake();
    await vi.runAllTimersAsync();

    // Then
    expect(reconcile).toHaveBeenCalledTimes(6);
    expect(unavailable).toHaveBeenCalledOnce();
    expect(unavailable).toHaveBeenCalledWith(failure);
    expect(started).toEqual([0, 1_000, 2_100, 3_600, 5_600, 11_600]);
    expect(Date.now()).toBe(12_600);
    await loop.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a scheduled retry and drains the active attempt during shutdown", async () => {
    // Given
    vi.useFakeTimers();
    let rejectAttempt: ((error: Error) => void) | undefined;
    const reconcile = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectAttempt = reject;
    }));
    const loop = createNativeProposalReconciliationLoop({ reconcile, unavailable: vi.fn() });
    loop.wake();
    await Promise.resolve();
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledOnce();
    rejectAttempt?.(new Error("transient proposal store failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    // When
    await loop.close();
    await vi.runAllTimersAsync();

    // Then
    expect(reconcile).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
