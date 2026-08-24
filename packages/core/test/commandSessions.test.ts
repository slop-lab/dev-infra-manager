import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CommandSessionManager } from "../../../../core/packages/core/src/commandSessions.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

class SessionTestRunner implements StreamingCommandRunner {
  async run(command: string, args: string[]): Promise<CommandResult> {
    return { command, args, stdout: "checked\n", stderr: "", exitCode: 0 };
  }

  async runStreaming(_command: string, _args: string[], options: RunOptions = {}): Promise<number> {
    options.stdout?.write("ready\n");
    const input = options.stdin as PassThrough;
    return await new Promise((resolve) => input.once("data", (chunk) => {
      options.stderr?.write(`input:${String(chunk)}`);
      resolve(7);
    }));
  }
}

describe("command sessions", () => {
  it("buffers command output, accepts input, and reports the final result", async () => {
    const sessions = new CommandSessionManager(new SessionTestRunner());
    const id = sessions.start(async (runner) => {
      await runner.run("inspect", []);
      return { exitCode: await runner.runStreaming("execute", []) };
    });
    sessions.input(id, Buffer.from("hello"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.snapshot(id)?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "command", command: "inspect" }),
      expect.objectContaining({ type: "stdout", data: "checked\n" }),
      expect.objectContaining({ type: "stdout", data: "ready\n" }),
      expect.objectContaining({ type: "stderr", data: "input:hello" }),
      expect.objectContaining({ type: "exit", exitCode: 7 }),
      expect.objectContaining({ type: "result", result: { exitCode: 7 } })
    ]));
  });

  it("propagates cancellation to the active command", async () => {
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        return { command, args, stdout: "", stderr: "", exitCode: 0 };
      },
      async runStreaming(_command, _args, options = {}) {
        return await new Promise((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(143), { once: true });
        });
      }
    };
    const sessions = new CommandSessionManager(runner);
    const id = sessions.start(async (sessionRunner) => ({
      exitCode: await sessionRunner.runStreaming("long-running", [])
    }));
    expect(sessions.cancel(id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.snapshot(id)?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "exit", exitCode: 143 }),
      expect.objectContaining({ type: "result", result: { exitCode: 143 } })
    ]));
  });
});
