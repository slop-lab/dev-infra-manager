import type { NativeQemuAuthorityClient } from "./nativeQemuAuthorityClient.js";
import type { NativeQemuSchedulerStore } from "./nativeQemuSchedulerStore.js";

const retryMilliseconds = 1_000;

export class NativeQemuResultReporter {
  #closed = false;
  #running = false;
  #retry: NodeJS.Timeout | undefined;

  constructor(readonly store: NativeQemuSchedulerStore, readonly authority: NativeQemuAuthorityClient) {
    this.wake();
  }

  wake(): void {
    if (this.#closed || this.#running) return;
    this.#running = true;
    queueMicrotask(() => { void this.#drain(); });
  }

  close(): void {
    this.#closed = true;
    if (this.#retry !== undefined) clearTimeout(this.#retry);
  }

  async #drain(): Promise<void> {
    try {
      for (const report of this.store.pendingReports()) {
        if (this.#closed) return;
        try {
          await this.authority.report(report.claim, report.terminalEvent, AbortSignal.timeout(10_000));
          this.store.acknowledgeResult(report.claim.claimId);
        } catch {
          this.#retry = setTimeout(() => {
            this.#retry = undefined;
            this.wake();
          }, retryMilliseconds);
          return;
        }
      }
    } finally {
      this.#running = false;
    }
  }
}
