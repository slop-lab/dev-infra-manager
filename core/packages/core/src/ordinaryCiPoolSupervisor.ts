import { UserError } from "./errors.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import { readOrdinaryCiPoolConnection } from "./ordinaryCiPoolConfig.js";
import { runOrdinaryCiPoolCapacityOnce } from "./ordinaryCiPoolRuntime.js";
import type { StreamingCommandRunner } from "./types.js";

export type OrdinaryCiCapacityWorker = (
  capacity: string,
  signal: AbortSignal
) => Promise<void>;

export type OrdinaryCiPoolSupervisorOptions = {
  readonly initialRestartDelayMilliseconds: number;
  readonly maximumRestartDelayMilliseconds: number;
  readonly onFailure: (capacity: string, error: unknown, delayMilliseconds: number) => void;
};

const DEFAULT_OPTIONS = {
  initialRestartDelayMilliseconds: 1_000,
  maximumRestartDelayMilliseconds: 30_000,
  onFailure: () => undefined
} as const satisfies OrdinaryCiPoolSupervisorOptions;

export class OrdinaryCiPoolSupervisor {
  readonly #capacities: readonly string[];
  readonly #worker: OrdinaryCiCapacityWorker;
  readonly #options: OrdinaryCiPoolSupervisorOptions;
  #abort: AbortController | undefined;
  #tasks: readonly Promise<void>[] = [];
  #transition: Promise<void> = Promise.resolve();
  #disposed = false;
  #failure: AggregateError | undefined;

  constructor(
    capacities: readonly string[],
    worker: OrdinaryCiCapacityWorker,
    options: Partial<OrdinaryCiPoolSupervisorOptions> = {}
  ) {
    this.#capacities = capacities;
    this.#worker = worker;
    this.#options = { ...DEFAULT_OPTIONS, ...options };
  }

  resume(): Promise<void> {
    if (this.#disposed) return Promise.reject(new UserError("ordinary CI capacity supervisor is disposed"));
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    return this.#serialize(async () => {
      if (this.#disposed) throw new UserError("ordinary CI capacity supervisor is disposed");
      if (this.#failure !== undefined) throw this.#failure;
      if (this.#abort !== undefined) return;
      const abort = new AbortController();
      this.#abort = abort;
      this.#tasks = this.#capacities.map((capacity) => this.#serve(capacity, abort.signal));
    });
  }

  quiesce(): Promise<void> {
    return this.#serialize(async () => {
      const abort = this.#abort;
      if (abort === undefined) return;
      abort.abort();
      const results = await Promise.allSettled(this.#tasks);
      const errors: unknown[] = [];
      for (const result of results) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      if (errors.length > 0) {
        const detail = errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
        this.#failure = new AggregateError(errors, `ordinary CI capacity cleanup failed: ${detail}`);
        throw this.#failure;
      }
      if (this.#abort === abort) {
        this.#abort = undefined;
        this.#tasks = [];
      }
    });
  }

  dispose(): Promise<void> {
    this.#disposed = true;
    return this.quiesce();
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.#transition.then(operation);
    this.#transition = result.catch(() => undefined);
    return result;
  }

  async #serve(capacity: string, signal: AbortSignal): Promise<void> {
    let delayMilliseconds = this.#options.initialRestartDelayMilliseconds;
    while (!signal.aborted) {
      try {
        await this.#worker(capacity, signal);
        delayMilliseconds = this.#options.initialRestartDelayMilliseconds;
      } catch (error) {
        if (signal.aborted) {
          if (error === signal.reason) return;
          throw error;
        }
        this.#options.onFailure(capacity, error, delayMilliseconds);
        await wait(delayMilliseconds, signal);
        delayMilliseconds = Math.min(delayMilliseconds * 2, this.#options.maximumRestartDelayMilliseconds);
      }
    }
  }
}

export async function configuredOrdinaryCiPoolSupervisor(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  onFailure?: OrdinaryCiPoolSupervisorOptions["onFailure"]
): Promise<OrdinaryCiPoolSupervisor | undefined> {
  const file = options.ordinaryCiPoolConnection?.file;
  if (file === undefined) return undefined;
  const connection = await readOrdinaryCiPoolConnection(file);
  const supervisor = new OrdinaryCiPoolSupervisor(
    connection.capacities,
    async (capacity, signal) => {
      const result = await runOrdinaryCiPoolCapacityOnce(runner, options, capacity, signal);
      if (result.status === "idle") await wait(1_000, signal);
    },
    onFailure === undefined ? {} : { onFailure }
  );
  return supervisor;
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", stop, { once: true });
  });
}
