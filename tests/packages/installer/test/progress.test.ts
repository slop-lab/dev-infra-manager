import { describe, expect, it, vi } from "vitest";
import {
  createInstallerProgress,
  withInstallerProgress,
  type InstallerProgressStream,
  type ProgressScheduler,
  type ProgressTimer
} from "../../../../core/packages/installer/src/installProgress.js";

class Timer implements ProgressTimer {
  cancelled = false;
  constructor(readonly callback: () => void) {}
  cancel(): void { this.cancelled = true; }
  unref(): void {}
}

class Scheduler implements ProgressScheduler {
  readonly timers: Timer[] = [];
  setTimeout(callback: () => void): Timer {
    const timer = new Timer(callback);
    this.timers.push(timer);
    return timer;
  }
  clearTimeout(timer: ProgressTimer): void { timer.cancel(); }
  fire(): void {
    const timer = this.timers.find((candidate) => !candidate.cancelled);
    if (timer === undefined) throw new Error("missing active timer");
    timer.cancelled = true;
    timer.callback();
  }
}

class Stream implements InstallerProgressStream {
  readonly chunks: Buffer[] = [];
  constructor(readonly isTTY: boolean, readonly columns = 160) {}
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    return true;
  }
  text(): string { return Buffer.concat(this.chunks).toString(); }
}

describe("installer progress", () => {
  it("renders real core installation milestones and omits completed work", () => {
    const scheduler = new Scheduler();
    const stream = new Stream(true);
    const progress = createInstallerProgress("core", { scheduler, stream, idleDelayMs: 1 });

    scheduler.fire();
    expect(stream.text()).toContain("Current: package installation");
    expect(stream.text()).toContain("Remaining: version verification, state preflight, runtime promotion, controller readiness, configuration");
    progress.update("controller readiness");
    scheduler.fire();
    expect(stream.chunks.at(-1)?.toString()).toContain("Current: controller readiness");
    expect(stream.chunks.at(-1)?.toString()).toContain("Remaining: configuration");
  });

  it("does not schedule or alter bytes when stderr is not a TTY", () => {
    const scheduler = new Scheduler();
    const stream = new Stream(false);
    const progress = createInstallerProgress("plugin", { scheduler, stream });
    const payload = Buffer.from([0, 255, 27, 10]);

    progress.activity();
    stream.write(payload);
    progress.stop();

    expect(scheduler.timers).toHaveLength(0);
    expect(stream.chunks[0]).toEqual(payload);
  });

  it("clears visible progress before cancellation", () => {
    const scheduler = new Scheduler();
    const stream = new Stream(true);
    const progress = createInstallerProgress("plugin", { scheduler, stream });
    const abort = vi.fn();

    scheduler.fire();
    progress.cancel(abort);

    expect(abort).toHaveBeenCalledOnce();
    expect(stream.chunks.at(-1)?.toString()).toBe("\r\u001b[K\u001b[1A\r\u001b[K");
  });

  it("SIGINT aborts installer work and removes its listener", async () => {
    const listeners = process.listeners("SIGINT");
    const installation = withInstallerProgress("core", async ({ signal }) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const signalHandler = process.listeners("SIGINT").find((listener) => !listeners.includes(listener));

    expect(signalHandler).toBeDefined();
    signalHandler?.("SIGINT");
    await expect(installation).rejects.toThrow("installer core cancelled");
    expect(process.listeners("SIGINT")).toEqual(listeners);
  });

  it("keeps handling SIGINT until cancelled installation has finished restoring state", async () => {
    const listeners = process.listeners("SIGINT");
    let finish: (() => void) | undefined;
    const installation = withInstallerProgress("core", async ({ signal }) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    const handler = process.listeners("SIGINT").find((listener) => !listeners.includes(listener));

    try {
      expect(handler).toBeDefined();
      process.emit("SIGINT");
      expect(process.listeners("SIGINT")).toContain(handler);
      process.emit("SIGINT");
      expect(process.listeners("SIGINT")).toContain(handler);
    } finally {
      await Promise.resolve();
      finish?.();
      await installation;
    }
    expect(process.listeners("SIGINT")).toEqual(listeners);
  });

  it("installer failures remove their signal listener unchanged", async () => {
    const listeners = process.listeners("SIGINT");
    const failure = new Error("installation failed unchanged");

    await expect(withInstallerProgress("plugin", async () => { throw failure; })).rejects.toBe(failure);
    expect(process.listeners("SIGINT")).toEqual(listeners);
  });
});
