import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CommandSessionManager } from "../../../../core/packages/core/src/commandSessions.js";
import { ProcessRunner } from "../../../../core/packages/core/src/runner.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

class SessionTestRunner implements StreamingCommandRunner {
  readonly terminalSizes: Array<{ columns: number; rows: number }> = [];

  async run(command: string, args: string[]): Promise<CommandResult> {
    return { command, args, stdout: "checked\n", stderr: "", exitCode: 0 };
  }

  async runStreaming(_command: string, _args: string[], options: RunOptions = {}): Promise<number> {
    options.stdout?.write("ready\n");
    options.stdout?.write(Buffer.from([0x1f, 0x8b, 0xff]));
    if (typeof options.terminal === "object") {
      this.terminalSizes.push({ columns: options.terminal.columns, rows: options.terminal.rows });
      options.terminal.onResize((size) => this.terminalSizes.push(size));
    }
    const input = options.stdin as PassThrough;
    return await new Promise((resolve) => input.once("data", (chunk) => {
      options.stderr?.write(`input:${String(chunk)}`);
      resolve(7);
    }));
  }
}

describe("command sessions", () => {
  it("buffers command output, accepts input, and reports the final result", async () => {
    const runner = new SessionTestRunner();
    const sessions = new CommandSessionManager(runner);
    const id = sessions.start(async (runner) => {
      await runner.run("inspect", []);
      return { exitCode: await runner.runStreaming("execute", [], { terminal: true }) };
    }, { columns: 100, rows: 40 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.resize(id, { columns: 120, rows: 50 })).toBe(true);
    sessions.input(id, Buffer.from("hello"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.snapshot(id)?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "command", command: "execute" }),
      expect.objectContaining({ type: "stdout", data: Buffer.from("ready\n").toString("base64"), encoding: "base64" }),
      expect.objectContaining({
        type: "stdout", data: Buffer.from([0x1f, 0x8b, 0xff]).toString("base64"), encoding: "base64"
      }),
      expect.objectContaining({
        type: "stderr", data: Buffer.from("input:hello").toString("base64"), encoding: "base64"
      }),
      expect.objectContaining({ type: "exit", exitCode: 7 }),
      expect.objectContaining({ type: "result", result: { exitCode: 7 } })
    ]));
    expect(sessions.snapshot(id)?.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ data: Buffer.from("checked\n").toString("base64") })
    ]));
    expect(runner.terminalSizes).toEqual([
      { columns: 100, rows: 40 },
      { columns: 120, rows: 50 }
    ]);
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

  it("runs interactive commands in a real resizable Linux PTY", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => { text += chunk; });
    let resize: ((size: { columns: number; rows: number }) => void) | undefined;
    const completed = new ProcessRunner().runStreaming("sh", [
      "-c", "stty size; IFS= read -r line; stty size; printf '<%s>' \"$line\""
    ], {
      stdin: input,
      stdout: output,
      stderr: output,
      terminal: {
        columns: 91,
        rows: 33,
        onResize(listener) { resize = listener; return () => { resize = undefined; }; }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    resize?.({ columns: 120, rows: 44 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    input.end("hello\n");
    await expect(completed).resolves.toBe(0);
    expect(text).toContain("33 91");
    // A Sysbox-hosted runner permits creating and using the PTY but does not
    // apply a window resize issued by opening that PTY from a sibling process.
    // The affected CI lane declares that executor capability explicitly;
    // normal hosts and disposable-QEMU lanes retain the resize assertion.
    if (process.env.DIM_TEST_PTY_RESIZE !== "unsupported") {
      expect(text).toContain("44 120");
    }
    expect(text).toContain("<hello>");
  });
});
