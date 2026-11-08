import { setTimeout as pause } from "node:timers/promises";
import { UserError, type RunOptions, type StreamingCommandRunner } from "@slop-lab/dim-host-core/workspace";
import type { VmBudget } from "./budget.js";

/** One monotonic host-owned deadline; cleanup never uses this cancelled view. */
export class VmStartupDeadline {
  private readonly end: number;
  private readonly abort = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private stage = "host admission";
  private readonly signal: AbortSignal;
  constructor(readonly milliseconds: number, private readonly parent?: AbortSignal) {
    this.end = performance.now() + milliseconds;
    this.signal = parent ? AbortSignal.any([parent, this.abort.signal]) : this.abort.signal;
    this.timer = setTimeout(() => this.abort.abort(), milliseconds);
    this.timer.unref();
  }
  at(stage: string): void { this.stage = stage; this.check(); }
  check(): void {
    this.parent?.throwIfAborted();
    if (this.abort.signal.aborted || performance.now() >= this.end) throw new UserError(`VM startup deadline exceeded while waiting for ${this.stage}`);
  }
  close(): void { clearTimeout(this.timer); }
  private options(options: RunOptions = {}): RunOptions {
    this.check(); options.signal?.throwIfAborted();
    return { ...options, signal: options.signal ? AbortSignal.any([options.signal, this.signal]) : this.signal };
  }
  private async perform<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.check(); signal?.throwIfAborted();
    try { const result = await action(); this.check(); signal?.throwIfAborted(); return result; }
    catch (error) { this.check(); signal?.throwIfAborted(); throw error; }
  }
  runner(runner: StreamingCommandRunner): StreamingCommandRunner {
    return {
      run: (file, args, options) => { const bounded = this.options(options); return this.perform(() => runner.run(file, args, bounded), bounded.signal); },
      runStreaming: (file, args, options) => { const bounded = this.options(options); return this.perform(() => runner.runStreaming(file, args, bounded), bounded.signal); }
    };
  }
  budget(budget: VmBudget): VmBudget {
    const perform = <T>(options: Pick<RunOptions, "signal"> | undefined, action: (bounded: RunOptions) => Promise<T>) => {
      const bounded = this.options(options); return this.perform(() => action(bounded), bounded.signal);
    };
    return {
      ...(budget.prepare ? { prepare: (identity, resources, options) => perform(options, (bounded) => budget.prepare!(identity, resources, bounded)) } : {}),
      apply: (identity, resources, options) => perform(options, (bounded) => budget.apply(identity, resources, bounded)),
      verify: (identity, resources, options) => perform(options, (bounded) => budget.verify(identity, resources, bounded)),
      ...(budget.release ? { release: (instance, options) => perform(options, (bounded) => budget.release!(instance, bounded)) } : {})
    };
  }
  async retry(): Promise<void> {
    this.check();
    try { await pause(Math.min(250, Math.max(1, this.end - performance.now())), undefined, { signal: this.signal }); }
    catch (error) { this.check(); throw error; }
    this.check();
  }
}
