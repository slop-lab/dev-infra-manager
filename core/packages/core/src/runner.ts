import { spawn } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import type { CommandResult, CommandRunner, RunOptions, StreamingCommandRunner, TerminalControl, TerminalSize } from "./types.js";

const TERMINATE_GRACE_MILLISECONDS = 1_000;
const KILL_GRACE_MILLISECONDS = 1_000;

export class ProcessRunner implements StreamingCommandRunner {
  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    const actualCommand = options.sudo ? "sudo" : command;
    const actualArgs = options.sudo ? [command, ...args] : args;

    return new Promise((resolve) => {
      const child = spawn(actualCommand, actualArgs, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let terminateTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (exitCode: number, diagnostic = stderr) => {
        if (settled) return;
        settled = true;
        if (terminateTimer !== undefined) clearTimeout(terminateTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
        resolve({ command: actualCommand, args: actualArgs, stdout, stderr: diagnostic, exitCode });
      };
      const abort = () => {
        child.kill("SIGTERM");
        terminateTimer = setTimeout(() => {
          child.kill("SIGKILL");
          killTimer = setTimeout(() => {
            finish(137, `${stderr}${stderr.length === 0 ? "" : "\n"}command did not exit after SIGKILL`);
          }, KILL_GRACE_MILLISECONDS);
        }, TERMINATE_GRACE_MILLISECONDS);
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        finish(127, error.message);
      });
      child.on("close", (exitCode, signal) => {
        const signalExitCode = signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : 1;
        finish(exitCode ?? signalExitCode);
      });
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async runStreaming(command: string, args: string[], options: RunOptions = {}): Promise<number> {
    const actualCommand = options.sudo ? "sudo" : command;
    const actualArgs = options.sudo ? [command, ...args] : args;

    if (options.terminal) {
      return runInTerminal(actualCommand, actualArgs, options);
    }

    return new Promise((resolve) => {
      const child = spawn(actualCommand, actualArgs, {
        cwd: options.cwd,
        env: options.env,
        stdio: [options.stdin ? "pipe" : "inherit", options.stdout ? "pipe" : "inherit", options.stderr ? "pipe" : "inherit"]
      });
      if (options.stdin && child.stdin) options.stdin.pipe(child.stdin);
      if (options.stdout && child.stdout) child.stdout.pipe(options.stdout);
      if (options.stderr && child.stderr) child.stderr.pipe(options.stderr);
      const abort = () => child.kill("SIGTERM");
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      child.on("error", () => {
        resolve(127);
      });
      child.on("close", (exitCode) => {
        options.signal?.removeEventListener("abort", abort);
        resolve(exitCode ?? 1);
      });
    });
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
  return await new Promise((resolve) => {
    const child = spawn("script", [
      "--quiet", "--return", "--flush", "--command", shellCommand, "/dev/null"
    ], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", options.stdout ? "pipe" : "inherit", options.stderr ? "pipe" : "inherit"]
    });
    if (options.stdin && child.stdin) options.stdin.pipe(child.stdin);
    if (options.stdout && child.stdout) child.stdout.pipe(options.stdout);
    if (options.stderr && child.stderr) child.stderr.pipe(options.stderr);
    let resizeChain = Promise.resolve();
    const resize = (size: TerminalSize) => {
      resizeChain = resizeChain.then(() => resizeTerminalChild(child.pid, size));
    };
    const removeResize = typeof options.terminal === "object"
      ? options.terminal.onResize(resize)
      : () => {};
    const abort = () => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      options.stderr?.write(`failed to start terminal helper: ${error.message}\n`);
      resolve(127);
    });
    child.on("close", (exitCode) => {
      removeResize();
      options.signal?.removeEventListener("abort", abort);
      resolve(exitCode ?? 1);
    });
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

export class RecordingRunner implements CommandRunner {
  readonly commands: Array<{ command: string; args: string[]; sudo: boolean }> = [];

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    this.commands.push({ command, args, sudo: options.sudo ?? false });
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  }
}
