// node:timers/promises ESM bindings can retain Node's real timers after fake
// timers are installed. Use the fakeable globals for executor scheduling tests.
export function fakeTimerDelay<Value>(
  milliseconds: number,
  value: Value,
  options: { readonly signal?: AbortSignal } = {}
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted === true) { reject(signal.reason); return; }
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(value);
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
