import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../../core/packages/core/src/types.js";
export class ExecutorRunner implements StreamingCommandRunner {
  readonly calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  failRemoval = false;
  foreignOwnership = false;
  imageMismatch = false;
  launchResponseLost = false;
  abortOnWait: AbortController | undefined;
  logsExitCode = 0;
  logsWaitForAbort = false;
  waitCommandExitCode = 0;
  waitForAbort = false;
  waitUntil: Promise<void> | undefined;
  onWait: (() => void) | undefined;
  output = "executor-output\n";
  exitCode = 0;
  beforeLaunch: ((args: readonly string[]) => Promise<void>) | undefined;
  private labels: readonly string[] = [];

  async run(command: string, args: string[], options?: RunOptions): Promise<CommandResult> {
    this.calls.push({ command, args: [...args] });
    if (args[0] === "image" && args[1] === "inspect") {
      const image = args[2] ?? "";
      return result(command, args, JSON.stringify(this.imageMismatch ? [] : [image]));
    }
    if (args[0] === "run") {
      await this.beforeLaunch?.(args);
      this.labels = args.flatMap((value, index) => args[index - 1] === "--label" ? [value] : []);
      if (this.launchResponseLost) return result(command, args, "", 125);
      return result(command, args, `${"c".repeat(64)}\n`);
    }
    if (args[0] === "wait") {
      this.onWait?.();
      this.abortOnWait?.abort();
      await this.waitUntil;
      if (this.waitForAbort && !options?.signal?.aborted) await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return result(command, args, `${this.exitCode}\n`, this.waitCommandExitCode);
    }
    if (args[0] === "container" && args[1] === "inspect") {
      if (this.labels.length === 0) {
        return { command, args, stdout: "", stderr: `Error: No such container: ${args[2] ?? ""}`, exitCode: 1 };
      }
      const values = this.labels.map((label) => label.slice(label.indexOf("=") + 1));
      if (this.foreignOwnership) values[1] = "foreign";
      return result(command, args, `${"c".repeat(64)}|${values.join("|")}\n`);
    }
    if (args[0] === "container" && args[1] === "rm") return result(command, args, "", this.failRemoval ? 1 : 0);
    return result(command, args);
  }

  async runStreaming(command: string, args: string[], options?: RunOptions): Promise<number> {
    this.calls.push({ command, args: [...args] });
    options?.stdout?.write(this.output);
    if (this.logsWaitForAbort && !options?.signal?.aborted) {
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    }
    return this.logsExitCode;
  }
}


function result(command: string, args: string[], stdout = "", exitCode = 0): CommandResult {
  return { command, args, stdout, stderr: exitCode === 0 ? "" : "failed", exitCode };
}
