export const streamProgressOperations = [
  "workspace.create",
  "workspace.resources",
  "workspace.align",
  "workspace.setup",
  "workspace.update",
  "workspace.start",
  "workspace.restart",
  "workspace.stop",
  "workspace.discard",
  "ci.runner.create",
  "ci.runner.start",
  "ci.runner.restart",
  "ci.runner.stop",
  "ci.runner.delete",
  "ci.runner.logs",
  "host.start",
  "host.shutdown"
] as const;

type StreamProgressOperation = (typeof streamProgressOperations)[number];

const streamProgressLabels = {
  "workspace.create": "Creating workspace",
  "workspace.resources": "Updating workspace resources",
  "workspace.align": "Aligning workspace",
  "workspace.setup": "Setting up workspace",
  "workspace.update": "Updating workspace",
  "workspace.start": "Starting workspace",
  "workspace.restart": "Restarting workspace",
  "workspace.stop": "Stopping workspace",
  "workspace.discard": "Discarding workspace",
  "ci.runner.create": "Creating CI runner",
  "ci.runner.start": "Starting CI runner",
  "ci.runner.restart": "Restarting CI runner",
  "ci.runner.stop": "Stopping CI runner",
  "ci.runner.delete": "Deleting CI runner",
  "ci.runner.logs": "Following CI runner logs",
  "host.start": "Starting host runtimes",
  "host.shutdown": "Stopping host runtimes"
} satisfies Record<StreamProgressOperation, string>;

const spinnerFrames = ["-", "\\", "|", "/"] as const;
const clearLine = "\r\u001b[K";
const defaultIdleDelayMs = 5_000;
const defaultFrameIntervalMs = 120;

export interface ProgressTimer {
  cancel(): void;
  unref(): void;
}

export interface ProgressScheduler {
  setTimeout(callback: () => void, delay: number): ProgressTimer;
  clearTimeout(timer: ProgressTimer): void;
}

export interface ProgressStream {
  readonly isTTY?: boolean;
  write(chunk: string | Uint8Array): boolean;
}

export interface CliProgress {
  activity(): void;
  stop(): void;
}

export interface AdminStreamOptions {
  readonly stdin?: boolean;
  readonly terminal?: boolean;
}

interface ProgressDependencies {
  readonly stream?: ProgressStream;
  readonly scheduler?: ProgressScheduler;
  readonly idleDelayMs?: number;
  readonly frameIntervalMs?: number;
}

const defaultScheduler: ProgressScheduler = {
  setTimeout(callback, delay) {
    const timer = setTimeout(callback, delay);
    return {
      cancel: () => clearTimeout(timer),
      unref: () => timer.unref()
    };
  },
  clearTimeout(timer) {
    timer.cancel();
  }
};

const inactiveProgress: CliProgress = {
  activity() {},
  stop() {}
};

export function streamProgressLabel(operation: string): string | undefined {
  for (const candidate of streamProgressOperations) {
    if (candidate === operation) return streamProgressLabels[candidate];
  }
  return undefined;
}

export function createAdminStreamProgress(
  operation: string,
  options: AdminStreamOptions = {},
  dependencies: ProgressDependencies = {}
): CliProgress {
  const stream = dependencies.stream ?? process.stderr;
  const label = options.stdin || options.terminal ? undefined : streamProgressLabel(operation);
  if (label === undefined || stream.isTTY !== true) return inactiveProgress;

  const scheduler = dependencies.scheduler ?? defaultScheduler;
  const idleDelayMs = dependencies.idleDelayMs ?? defaultIdleDelayMs;
  const frameIntervalMs = dependencies.frameIntervalMs ?? defaultFrameIntervalMs;
  let timer: ProgressTimer | undefined;
  let frameIndex = 0;
  let visible = false;
  let stopped = false;

  const cancelTimer = (): void => {
    if (timer === undefined) return;
    scheduler.clearTimeout(timer);
    timer = undefined;
  };
  const clear = (): void => {
    if (!visible) return;
    stream.write(clearLine);
    visible = false;
  };
  const schedule = (delay: number): void => {
    timer = scheduler.setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      stream.write(`\r${spinnerFrames[frameIndex] ?? "-"} ${label}`);
      visible = true;
      frameIndex = (frameIndex + 1) % spinnerFrames.length;
      schedule(frameIntervalMs);
    }, delay);
    timer.unref();
  };

  schedule(idleDelayMs);
  return {
    activity() {
      if (stopped) return;
      cancelTimer();
      clear();
      schedule(idleDelayMs);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancelTimer();
      clear();
    }
  };
}
