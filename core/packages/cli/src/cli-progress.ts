import { initialOperationProgress, operationProgressStage } from "./operation-progress.js";

export const streamProgressOperations = [
  "workspace.create",
  "workspace.resources",
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
  "host.shutdown",
  "image.workspace.build",
  "image.git-sync.build",
  "image.qemu-scheduler.build",
  "repo.import",
  "repo.fetch",
  "repo.publish",
  "repo.apply",
  "project.create"
] as const;

type StreamProgressOperation = (typeof streamProgressOperations)[number];

const streamProgressLabels = {
  "workspace.create": "Creating workspace",
  "workspace.resources": "Updating workspace resources",
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
  "host.shutdown": "Stopping host runtimes",
  "image.workspace.build": "Building workspace image",
  "image.git-sync.build": "Building Git sync image",
  "image.qemu-scheduler.build": "Building QEMU scheduler image",
  "repo.import": "Importing repository",
  "repo.fetch": "Fetching repository",
  "repo.publish": "Publishing repository",
  "repo.apply": "Applying repository set",
  "project.create": "Creating Project"
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
  readonly columns?: number;
  write(chunk: string | Uint8Array): boolean;
}

export interface CliProgress {
  activity(): void;
  update(stage: string): void;
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
  update() {},
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
  const initialStatus = initialOperationProgress(operation);

  const scheduler = dependencies.scheduler ?? defaultScheduler;
  const idleDelayMs = dependencies.idleDelayMs ?? defaultIdleDelayMs;
  const frameIntervalMs = dependencies.frameIntervalMs ?? defaultFrameIntervalMs;
  let timer: ProgressTimer | undefined;
  let frameIndex = 0;
  let visible = false;
  let stopped = false;
  let current = initialStatus?.current ?? label;
  let remaining = initialStatus?.remaining ?? [];
  let visibleLines = 0;

  const cancelTimer = (): void => {
    if (timer === undefined) return;
    scheduler.clearTimeout(timer);
    timer = undefined;
  };
  const clear = (): void => {
    if (!visible) return;
    stream.write(clearLine);
    for (let line = 1; line < visibleLines; line += 1) stream.write(`\u001b[1A${clearLine}`);
    visible = false;
    visibleLines = 0;
  };
  const resetIdleDelay = (): void => {
    cancelTimer();
    clear();
    schedule(idleDelayMs);
  };
  const schedule = (delay: number): void => {
    timer = scheduler.setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      clear();
      const lines = [
        `${spinnerFrames[frameIndex] ?? "-"} Current: ${current}`,
        ...(remaining.length > 0 ? [`  Remaining: ${remaining.join(", ")}`] : [])
      ].map((line) => fitTerminalWidth(line, stream.columns));
      stream.write(`\r${lines.join("\n")}`);
      visible = true;
      visibleLines = lines.length;
      frameIndex = (frameIndex + 1) % spinnerFrames.length;
      schedule(frameIntervalMs);
    }, delay);
    timer.unref();
  };

  schedule(idleDelayMs);
  return {
    activity() {
      if (stopped) return;
      resetIdleDelay();
    },
    update(stage) {
      if (stopped) return;
      const status = operationProgressStage(operation, stage);
      if (status === undefined) return;
      current = status.current;
      remaining = status.remaining;
      resetIdleDelay();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancelTimer();
      clear();
    }
  };
}

function fitTerminalWidth(line: string, columns: number | undefined): string {
  if (columns === undefined || columns < 1 || line.length <= columns) return line;
  if (columns <= 3) return line.slice(0, columns);
  return `${line.slice(0, columns - 3)}...`;
}
