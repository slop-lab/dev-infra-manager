import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import { readdir, readlink } from "node:fs/promises";
import type { CommandResult, RunOptions, StreamingCommandRunner, TerminalControl, TerminalSize } from "./types.js";

const TERMINATE_GRACE_MILLISECONDS = 1_000;
const KILL_GRACE_MILLISECONDS = 1_000;

export class ProcessRunner implements StreamingCommandRunner {
  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    const actualCommand = options.sudo ? "sudo" : command;
    const actualArgs = options.sudo ? [command, ...args] : args;

    const output = new PassThrough();
    const errors = new PassThrough();
    let stdout = "";
    let stderr = "";
    output.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    errors.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const exitCode = await this.runStreaming(command, args, {
      ...options, terminal: false, stdin: options.stdin ?? Readable.from([]), stdout: output, stderr: errors
    });
    return { command: actualCommand, args: actualArgs, stdout, stderr, exitCode };
  }

  async runStreaming(command: string, args: string[], options: RunOptions = {}): Promise<number> {
    const actualCommand = options.sudo ? "sudo" : command;
    const actualArgs = options.sudo ? [command, ...args] : args;

    if (options.terminal) {
      return runInTerminal(actualCommand, actualArgs, options);
    }

    const child = spawn(actualCommand, actualArgs, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: [options.stdin ? "pipe" : "inherit", options.stdout ? "pipe" : "inherit", options.stderr ? "pipe" : "inherit"]
    });
    attachInput(child, options);
    if (options.stdout && child.stdout) child.stdout.pipe(options.stdout);
    if (options.stderr && child.stderr) child.stderr.pipe(options.stderr);
    return processExit(child, options);
  }
}

async function runInTerminal(command: string, args: string[], options: RunOptions): Promise<number> {
  const terminal = typeof options.terminal === "object"
    ? options.terminal
    : localTerminalControl();
  const shellCommand = [
    "stty", "cols", String(terminal.columns), "rows", String(terminal.rows), ";", "exec",
    shellQuote(command), ...args.map(shellQuote)
  ].join(" ");
  const child = spawn("script", [
    "--quiet", "--return", "--flush", "--command", shellCommand, "/dev/null"
  ], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["pipe", options.stdout ? "pipe" : "inherit", options.stderr ? "pipe" : "inherit"]
  });
  attachInput(child, options);
  if (options.stdout && child.stdout) child.stdout.pipe(options.stdout);
  if (options.stderr && child.stderr) child.stderr.pipe(options.stderr);
  let resizeChain = Promise.resolve();
  const resize = (size: TerminalSize) => {
    resizeChain = resizeChain.then(() => resizeTerminalChild(child.pid, size));
  };
  const removeResize = typeof options.terminal === "object"
    ? options.terminal.onResize(resize)
    : () => {};
  try { return await processExit(child, options); }
  finally { removeResize(); }
}

function attachInput(child: ChildProcess, options: RunOptions): void {
  if (!options.stdin || !child.stdin) return;
  const input = options.stdin;
  const destination = child.stdin;
  // Commands may stop reading before their input producer finishes.
  destination.once("error", () => input.unpipe(destination));
  child.once("close", () => input.unpipe(destination));
  input.pipe(destination);
}

/** One owner for process-group lifetime in capture, streaming and PTY modes. */
function processExit(child: ChildProcess, options: RunOptions): Promise<number> {
  return new Promise((resolve) => {
    let terminating = false;
    let settled = false;
    let terminateTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) child.kill(signal);
      }
    };
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(terminateTimer); clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve(code);
    };
    const abort = () => {
      if (settled || terminating) return;
      terminating = true;
      signalGroup("SIGTERM");
      terminateTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        killTimer = setTimeout(() => finish(137), KILL_GRACE_MILLISECONDS);
      }, TERMINATE_GRACE_MILLISECONDS);
    };
    child.once("error", (error) => {
      options.stderr?.write(`failed to start process: ${error.message}\n`);
      finish(127);
    });
    child.once("close", (code, signal) => {
      if (terminating) signalGroup("SIGKILL");
      finish(code ?? (signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : 1));
    });
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
}

function localTerminalControl(): TerminalControl {
  return {
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    onResize(listener) {
      const resize = () => listener({
        columns: process.stdout.columns || 80,
        rows: process.stdout.rows || 24
      });
      process.stdout.on("resize", resize);
      return () => process.stdout.off("resize", resize);
    }
  };
}

async function resizeTerminalChild(scriptPid: number | undefined, size: TerminalSize): Promise<void> {
  if (scriptPid === undefined) return;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const directory = `/proc/${scriptPid}/fd`;
      const descriptors = await readdir(directory);
      let terminalPath: string | undefined;
      for (const descriptor of descriptors) {
        const target = await readlink(`${directory}/${descriptor}`);
        if (/^\/dev\/pts\/\d+$/.test(target)) {
          terminalPath = target;
          break;
        }
      }
      if (terminalPath) {
        const exitCode = await new Promise<number | null>((resolve) => {
          const resize = spawn("stty", [
            "--file", terminalPath,
            "cols", String(size.columns), "rows", String(size.rows)
          ], { stdio: "ignore" });
          resize.on("error", () => resolve(127));
          resize.on("close", resolve);
        });
        if (exitCode === 0) return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
