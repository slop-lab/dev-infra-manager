import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { CommandResult, RunOptions, StreamingCommandRunner, TerminalControl, TerminalSize } from "./types.js";

export type CommandSessionEvent =
  | { sequence: number; type: "command"; command: string }
  | { sequence: number; type: "stdout" | "stderr"; data: string }
  | { sequence: number; type: "result"; result: unknown }
  | { sequence: number; type: "exit"; exitCode: number }
  | { sequence: number; type: "error"; error: string };

type UnsequencedCommandSessionEvent =
  | { type: "command"; command: string }
  | { type: "stdout" | "stderr"; data: string }
  | { type: "result"; result: unknown }
  | { type: "exit"; exitCode: number }
  | { type: "error"; error: string };

interface CommandSession {
  id: string;
  input: PassThrough;
  abort: AbortController;
  events: CommandSessionEvent[];
  listeners: Set<(event: CommandSessionEvent) => void>;
  nextSequence: number;
  complete: boolean;
  terminal: TerminalSize;
  resizeListeners: Set<(size: TerminalSize) => void>;
}

export class CommandSessionManager {
  readonly #sessions = new Map<string, CommandSession>();

  constructor(private readonly runner: StreamingCommandRunner) {}

  start(
    execute: (runner: StreamingCommandRunner) => Promise<unknown>,
    terminal: TerminalSize = { columns: 80, rows: 24 }
  ): string {
    const session: CommandSession = {
      id: randomUUID(),
      input: new PassThrough(),
      abort: new AbortController(),
      events: [],
      listeners: new Set(),
      nextSequence: 0,
      complete: false,
      terminal,
      resizeListeners: new Set()
    };
    this.#sessions.set(session.id, session);
    const runner = new SessionRunner(this.runner, session, (event) => this.#emit(session, event));
    void execute(runner).then(
      (result) => this.#emit(session, { type: "result", result }),
      (error) => this.#emit(session, {
        type: "error",
        error: error instanceof Error ? error.message : String(error)
      })
    ).finally(() => {
      session.complete = true;
      session.input.end();
      setTimeout(() => this.#sessions.delete(session.id), 300_000).unref();
    });
    return session.id;
  }

  snapshot(id: string): { events: CommandSessionEvent[]; complete: boolean } | undefined {
    const session = this.#sessions.get(id);
    return session && { events: [...session.events], complete: session.complete };
  }

  subscribe(id: string, listener: (event: CommandSessionEvent) => void): (() => void) | undefined {
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  input(id: string, data: Buffer, end = false): boolean {
    const session = this.#sessions.get(id);
    if (!session || session.complete) return false;
    if (data.length > 0) session.input.write(data);
    if (end) session.input.end();
    return true;
  }

  resize(id: string, size: TerminalSize): boolean {
    const session = this.#sessions.get(id);
    if (!session || session.complete) return false;
    session.terminal = size;
    for (const listener of session.resizeListeners) listener(size);
    return true;
  }

  cancel(id: string): boolean {
    const session = this.#sessions.get(id);
    if (!session || session.complete) return false;
    session.abort.abort();
    session.input.end();
    return true;
  }

  #emit(session: CommandSession, event: UnsequencedCommandSessionEvent): void {
    const sequenced = { ...event, sequence: session.nextSequence++ } as CommandSessionEvent;
    session.events.push(sequenced);
    if (session.events.length > 4_096) session.events.shift();
    for (const listener of session.listeners) listener(sequenced);
  }
}

class SessionRunner implements StreamingCommandRunner {
  constructor(
    private readonly runner: StreamingCommandRunner,
    private readonly session: CommandSession,
    private readonly emit: (event: UnsequencedCommandSessionEvent) => void
  ) {}

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    return await this.runner.run(command, args, {
      ...options,
      signal: this.session.abort.signal
    });
  }

  async runStreaming(command: string, args: string[], options: RunOptions = {}): Promise<number> {
    this.emit({ type: "command", command });
    const stdout = eventWriter((data) => this.emit({ type: "stdout", data }));
    const stderr = eventWriter((data) => this.emit({ type: "stderr", data }));
    const exitCode = await this.runner.runStreaming(command, args, {
      ...options,
      signal: this.session.abort.signal,
      stdin: this.session.input,
      stdout,
      stderr,
      ...(options.terminal ? { terminal: this.#terminalControl() } : {})
    });
    this.emit({ type: "exit", exitCode });
    return exitCode;
  }

  #terminalControl(): TerminalControl {
    return {
      ...this.session.terminal,
      onResize: (listener) => {
        this.session.resizeListeners.add(listener);
        return () => this.session.resizeListeners.delete(listener);
      }
    };
  }
}

function eventWriter(write: (data: string) => void): Writable {
  const decoder = new StringDecoder("utf8");
  return new Writable({
    write(chunk, _encoding, callback) {
      const decoded = decoder.write(Buffer.from(chunk));
      if (decoded) write(decoded);
      callback();
    },
    final(callback) {
      const decoded = decoder.end();
      if (decoded) write(decoded);
      callback();
    }
  });
}
