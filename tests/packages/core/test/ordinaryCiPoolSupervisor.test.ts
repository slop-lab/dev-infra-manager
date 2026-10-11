import { describe, expect, it, vi } from "vitest";
import {
  OrdinaryCiPoolSupervisor,
  type OrdinaryCiCapacityWorker
} from "../../../../core/packages/core/src/ordinaryCiPoolSupervisor.js";

describe("ordinary CI pool capacity supervision", () => {
  it("starts one owned task per configured host capacity", async () => {
    // Given
    const started: string[] = [];
    const worker: OrdinaryCiCapacityWorker = async (capacity, signal) => {
      started.push(capacity);
      await aborted(signal);
    };
    const supervisor = new OrdinaryCiPoolSupervisor(["primary", "secondary"], worker);

    // When
    await supervisor.resume();
    await vi.waitFor(() => expect(started).toEqual(["primary", "secondary"]));
    await supervisor.quiesce();

    // Then
    expect(started).toEqual(["primary", "secondary"]);
  });

  it("waits for owned cleanup before quiesce completes", async () => {
    // Given
    const events: string[] = [];
    const worker: OrdinaryCiCapacityWorker = async (_capacity, signal) => {
      events.push("started");
      await aborted(signal);
      events.push("cleanup");
    };
    const supervisor = new OrdinaryCiPoolSupervisor(["primary"], worker);
    await supervisor.resume();
    await vi.waitFor(() => expect(events).toEqual(["started"]));

    // When
    await supervisor.quiesce();

    // Then
    expect(events).toEqual(["started", "cleanup"]);
  });

  it("reports owned cleanup failure instead of accepting aborted work as quiesced", async () => {
    // Given
    const worker: OrdinaryCiCapacityWorker = async (_capacity, signal) => {
      await aborted(signal);
      throw new Error("owned cleanup failed");
    };
    const supervisor = new OrdinaryCiPoolSupervisor(["primary"], worker);
    await supervisor.resume();

    // When
    const quiesced = supervisor.quiesce();

    // Then
    await expect(quiesced).rejects.toThrow(/owned cleanup failed/);
  });

  it("reports capacity failures only after every capacity finishes cleanup", async () => {
    // Given
    const allowCleanup = new Barrier();
    const cleanupStarted = new Barrier();
    const events: string[] = [];
    const worker: OrdinaryCiCapacityWorker = async (capacity, signal) => {
      await aborted(signal);
      if (capacity === "primary") {
        events.push("primary:failed");
        throw new Error("primary cleanup failed");
      }
      events.push("secondary:cleanup-started");
      cleanupStarted.open();
      await allowCleanup.wait;
      events.push("secondary:cleanup-complete");
    };
    const supervisor = new OrdinaryCiPoolSupervisor(["primary", "secondary"], worker);
    await supervisor.resume();

    // When
    let settled = false;
    const quiesced = supervisor.quiesce().finally(() => {
      settled = true;
      events.push("quiesce:settled");
    });
    await cleanupStarted.wait;
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Then
    expect(settled).toBe(false);
    expect(events).toEqual(["primary:failed", "secondary:cleanup-started"]);
    allowCleanup.open();
    try {
      await quiesced;
      throw new Error("quiesce unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw error;
      expect(error.errors).toEqual([expect.objectContaining({ message: "primary cleanup failed" })]);
    }
    expect(events).toEqual([
      "primary:failed",
      "secondary:cleanup-started",
      "secondary:cleanup-complete",
      "quiesce:settled"
    ]);
    await expect(supervisor.resume()).rejects.toBeInstanceOf(AggregateError);
    expect(events.at(-1)).toBe("quiesce:settled");
  });

  it("terminally fences a queued resume when disposal begins", async () => {
    // Given
    const started: string[] = [];
    const supervisor = new OrdinaryCiPoolSupervisor(["primary"], async (capacity, signal) => {
      started.push(capacity);
      await aborted(signal);
    });

    // When
    const queuedResume = supervisor.resume();
    const disposal = supervisor.dispose();

    // Then
    await expect(queuedResume).rejects.toThrow(/disposed/);
    await expect(disposal).resolves.toBeUndefined();
    await expect(supervisor.resume()).rejects.toThrow(/disposed/);
    expect(started).toEqual([]);
  });

  it("restarts a failed capacity with delay bounded by the configured maximum", async () => {
    // Given
    vi.useFakeTimers();
    const delays: number[] = [];
    let attempts = 0;
    const worker: OrdinaryCiCapacityWorker = async (_capacity, signal) => {
      attempts += 1;
      if (attempts < 4) throw new Error("transient failure");
      await aborted(signal);
    };
    const supervisor = new OrdinaryCiPoolSupervisor(["primary"], worker, {
      initialRestartDelayMilliseconds: 10,
      maximumRestartDelayMilliseconds: 20,
      onFailure: (_capacity, _error, delay) => delays.push(delay)
    });

    // When
    await supervisor.resume();
    await vi.advanceTimersByTimeAsync(50);
    await supervisor.quiesce();
    vi.useRealTimers();

    // Then
    expect(attempts).toBe(4);
    expect(delays).toEqual([10, 20, 20]);
  });

  it("resets retry delay after one healthy capacity poll", async () => {
    // Given
    vi.useFakeTimers();
    const delays: number[] = [];
    let attempts = 0;
    const worker: OrdinaryCiCapacityWorker = async (_capacity, signal) => {
      attempts += 1;
      if (attempts === 1 || attempts === 3) throw new Error("transient failure");
      if (attempts > 3) await aborted(signal);
    };
    const supervisor = new OrdinaryCiPoolSupervisor(["primary"], worker, {
      initialRestartDelayMilliseconds: 10,
      maximumRestartDelayMilliseconds: 40,
      onFailure: (_capacity, _error, delay) => delays.push(delay)
    });

    // When
    await supervisor.resume();
    await vi.advanceTimersByTimeAsync(20);
    await supervisor.quiesce();
    vi.useRealTimers();

    // Then
    expect(delays).toEqual([10, 10]);
  });
});

async function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

class Barrier {
  readonly wait: Promise<void>;
  readonly #openBarrier: () => void;

  constructor() {
    let openBarrier = (): void => undefined;
    this.wait = new Promise((resolve) => { openBarrier = resolve; });
    this.#openBarrier = openBarrier;
  }

  open(): void {
    this.#openBarrier();
  }
}
