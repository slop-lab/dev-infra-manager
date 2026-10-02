const clearLine = "\r\u001b[K";
const frames = ["-", "\\", "|", "/"] as const;

const profiles = {
  core: ["package installation", "version verification", "state preflight", "runtime promotion", "controller readiness", "configuration"],
  plugin: ["runtime staging", "package installation", "runtime promotion", "controller readiness"]
} as const;

export interface ProgressTimer {
  cancel(): void;
  unref(): void;
}

export interface ProgressScheduler {
  setTimeout(callback: () => void, delay: number): ProgressTimer;
  clearTimeout(timer: ProgressTimer): void;
}

export interface InstallerProgressStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  write(chunk: string | Uint8Array): boolean;
}

export interface InstallerProgress {
  activity(): void;
  update(stage: string): void;
  stop(): void;
  cancel(abort: () => void): void;
}

export type InstallerOperation = {
  readonly signal: AbortSignal;
  readonly reportProgress: (stage: string) => void;
  readonly activity: () => void;
};

type Dependencies = {
  readonly stream?: InstallerProgressStream;
  readonly scheduler?: ProgressScheduler;
  readonly idleDelayMs?: number;
  readonly frameIntervalMs?: number;
};

const scheduler: ProgressScheduler = {
  setTimeout(callback, delay) {
    const timer = setTimeout(callback, delay);
    return { cancel: () => clearTimeout(timer), unref: () => timer.unref() };
  },
  clearTimeout(timer) { timer.cancel(); }
};

const inactive: InstallerProgress = {
  activity() {}, update() {}, stop() {}, cancel(abort) { abort(); }
};

export function createInstallerProgress(
  operation: keyof typeof profiles,
  dependencies: Dependencies = {}
): InstallerProgress {
  const stream = dependencies.stream ?? process.stderr;
  if (stream.isTTY !== true) return inactive;
  const stages = profiles[operation];
  const clock = dependencies.scheduler ?? scheduler;
  const idleDelay = dependencies.idleDelayMs ?? 5_000;
  const frameInterval = dependencies.frameIntervalMs ?? 120;
  let currentIndex = 0;
  let frameIndex = 0;
  let timer: ProgressTimer | undefined;
  let visibleLines = 0;
  let stopped = false;

  const clear = (): void => {
    if (visibleLines === 0) return;
    stream.write(`${clearLine}${visibleLines === 2 ? `\u001b[1A${clearLine}` : ""}`);
    visibleLines = 0;
  };
  const cancelTimer = (): void => {
    if (timer === undefined) return;
    clock.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (delay: number): void => {
    timer = clock.setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      clear();
      const current = stages[currentIndex] ?? stages[0];
      const remaining = stages.slice(currentIndex + 1);
      const lines = [
        `${frames[frameIndex] ?? "-"} Current: ${current}`,
        ...(remaining.length === 0 ? [] : [`  Remaining: ${remaining.join(", ")}`])
      ].map((line) => fit(line, stream.columns));
      stream.write(`\r${lines.join("\n")}`);
      visibleLines = lines.length;
      frameIndex = (frameIndex + 1) % frames.length;
      schedule(frameInterval);
    }, delay);
    timer.unref();
  };
  const reset = (): void => {
    cancelTimer();
    clear();
    schedule(idleDelay);
  };

  schedule(idleDelay);
  return {
    activity() { if (!stopped) reset(); },
    update(stage) {
      const index = stages.findIndex((candidate) => candidate === stage);
      if (!stopped && index >= 0) { currentIndex = index; reset(); }
    },
    stop() { if (!stopped) { stopped = true; cancelTimer(); clear(); } },
    cancel(abort) { this.stop(); abort(); }
  };
}

export async function withInstallerProgress<T>(
  operation: keyof typeof profiles,
  action: (context: InstallerOperation) => Promise<T>
): Promise<T> {
  const progress = createInstallerProgress(operation);
  const abort = new AbortController();
  const cancel = (): void => progress.cancel(() => abort.abort(new Error(`installer ${operation} cancelled`)));
  process.once("SIGINT", cancel);
  try {
    return await action({
      signal: abort.signal,
      reportProgress: (stage) => progress.update(stage),
      activity: () => progress.activity()
    });
  } finally {
    progress.stop();
    process.off("SIGINT", cancel);
  }
}

function fit(line: string, columns: number | undefined): string {
  if (columns === undefined || columns < 1 || line.length <= columns) return line;
  return columns <= 3 ? line.slice(0, columns) : `${line.slice(0, columns - 3)}...`;
}
