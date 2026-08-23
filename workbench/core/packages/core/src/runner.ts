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
        stdio: "inherit"
      });
      child.on("error", () => {
        resolve(127);
      });
      child.on("close", (exitCode) => {
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
