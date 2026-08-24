import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner, RunOptions, StreamingCommandRunner } from "./types.js";

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
      const abort = () => child.kill("SIGTERM");
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        resolve({
          command: actualCommand,
          args: actualArgs,
          stdout,
          stderr: error.message,
          exitCode: 127
        });
      });
      child.on("close", (exitCode) => {
        options.signal?.removeEventListener("abort", abort);
        resolve({
          command: actualCommand,
          args: actualArgs,
          stdout,
          stderr,
          exitCode: exitCode ?? 1
        });
      });
    });
  }

  async runStreaming(command: string, args: string[], options: RunOptions = {}): Promise<number> {
    const actualCommand = options.sudo ? "sudo" : command;
    const actualArgs = options.sudo ? [command, ...args] : args;

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

export class RecordingRunner implements CommandRunner {
  readonly commands: Array<{ command: string; args: string[]; sudo: boolean }> = [];

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    this.commands.push({ command, args, sudo: options.sudo ?? false });
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  }
}
