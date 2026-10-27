const retryDelaysMilliseconds = [0, 100, 500, 1_000, 5_000] as const;

export type NativeProposalReconciliationLoop = {
  readonly wake: () => void;
  readonly close: () => Promise<void>;
};

export function createNativeProposalReconciliationLoop(input: {
  readonly reconcile: () => Promise<void>;
  readonly unavailable: (error: unknown) => void;
}): NativeProposalReconciliationLoop {
  let closed = false;
  let exhausted = false;
  let pending = false;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  let running = Promise.resolve();
  let reconciling = false;

  const start = (): void => {
    if (closed || exhausted || reconciling || !pending || timer !== undefined) return;
    pending = false;
    reconciling = true;
    running = (async () => {
      if (closed) return;
      try {
        await input.reconcile();
        failures = 0;
      } catch (error) {
        if (closed) return;
        const delay = retryDelaysMilliseconds[failures];
        failures += 1;
        if (delay === undefined) {
          exhausted = true;
          input.unavailable(error);
          return;
        }
        timer = setTimeout(() => {
          timer = undefined;
          pending = true;
          start();
        }, delay);
        timer.unref();
      }
    })().finally(() => {
      reconciling = false;
      if (pending) queueMicrotask(start);
    });
  };

  return {
    wake() {
      if (closed || exhausted) return;
      pending = true;
      queueMicrotask(start);
    },
    async close() {
      closed = true;
      pending = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await running;
    }
  };
}
