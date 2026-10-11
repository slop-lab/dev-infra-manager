import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ProcessRunner } from "../../../../core/packages/core/src/runner.js";

describe("process runner cancellation", () => {
  it("escalates from SIGTERM to SIGKILL when a command ignores graceful termination", async () => {
    // Given
    const controller = new AbortController();
    const runner = new ProcessRunner();
    const startedAt = Date.now();
    const running = runner.run("env", ["--ignore-signal=TERM", "sleep", "60"], {
      signal: controller.signal
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // When
    controller.abort();
    const result = await running;

    // Then
    expect(result.exitCode).toBe(137);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("bounds streaming cancellation and kills the signal-ignoring process group", async () => {
    // Given
    const controller = new AbortController();
    const runner = new ProcessRunner();
    const stdout = new PassThrough();
    stdout.setEncoding("utf8");
    const pids = new Promise<readonly [number, number]>((resolve) => {
      stdout.once("data", (chunk: string) => {
        const [leader, descendant] = chunk.trim().split(" ").map(Number);
        if (leader === undefined || descendant === undefined) throw new Error("missing process ids");
        resolve([leader, descendant]);
      });
    });
    const running = runner.runStreaming("sh", [
      "-c", "trap '' TERM; sh -c 'trap \"\" TERM; while :; do :; done' & descendant=$!; printf '%s %s\\n' \"$$\" \"$descendant\"; wait"
    ], { signal: controller.signal, stdout });
    const processIds = await pids;

    // When
    const abortedAt = Date.now();
    controller.abort();
    let timeout: NodeJS.Timeout | undefined;
    try {
      const exitCode = await Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("streaming cancellation exceeded bounded grace")), 2_500);
        })
      ]);

      // Then
      expect(exitCode).toBe(137);
      expect(Date.now() - abortedAt).toBeLessThan(2_500);
      await expect(Promise.all(processIds.map((pid) => waitUntilDead(runner, pid)))).resolves.toEqual([undefined, undefined]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      await Promise.all(processIds.map((pid) => runner.run("kill", ["-KILL", String(pid)])));
      await running;
    }
  }, 5_000);

  it("kills a signal-ignoring descendant when the streaming leader exits on SIGTERM", async () => {
    // Given
    const controller = new AbortController();
    const runner = new ProcessRunner();
    const stdout = new PassThrough();
    stdout.setEncoding("utf8");
    const pids = new Promise<readonly [number, number]>((resolve) => {
      stdout.once("data", (chunk: string) => {
        const [leader, descendant] = chunk.trim().split(" ").map(Number);
        if (leader === undefined || descendant === undefined) throw new Error("missing process ids");
        resolve([leader, descendant]);
      });
    });
    const running = runner.runStreaming("sh", [
      "-c",
      "ready=; trap 'ready=1' USR1; sh -c 'trap \"\" TERM; exec </dev/null >/dev/null 2>&1; kill -USR1 \"$1\"; while :; do :; done' sh \"$$\" & descendant=$!; while [ -z \"$ready\" ]; do :; done; printf '%s %s\\n' \"$$\" \"$descendant\"; wait"
    ], { signal: controller.signal, stdout });
    const processIds = await pids;

    // When
    const abortedAt = Date.now();
    controller.abort();
    try {
      const exitCode = await running;

      // Then
      expect(exitCode).toBe(143);
      await expect(waitUntilAbsent(runner, processIds[1])).resolves.toBeUndefined();
      expect(Date.now() - abortedAt).toBeLessThan(1_000);
    } finally {
      await Promise.all(processIds.map((pid) => runner.run("kill", ["-KILL", String(pid)])));
      await running;
    }
  }, 3_000);

  it("preserves streamed stdout, stderr, and normal exit status", async () => {
    // Given
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let standardOutput = "";
    let standardError = "";
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (chunk: string) => { standardOutput += chunk; });
    stderr.on("data", (chunk: string) => { standardError += chunk; });

    // When
    const exitCode = await new ProcessRunner().runStreaming("sh", [
      "-c", "printf output; printf error >&2; exit 7"
    ], { stdout, stderr });

    // Then
    expect(exitCode).toBe(7);
    expect(standardOutput).toBe("output");
    expect(standardError).toBe("error");
  });
});

async function waitUntilDead(runner: ProcessRunner, pid: number): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const status = await runner.run("ps", ["-o", "stat=", "-p", String(pid)]);
    if (status.exitCode !== 0 || status.stdout.trim().startsWith("Z")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process ${pid} remained alive after cancellation`);
}

async function waitUntilAbsent(runner: ProcessRunner, pid: number): Promise<void> {
  const deadline = Date.now() + 750;
  while (Date.now() < deadline) {
    const status = await runner.run("ps", ["-p", String(pid)]);
    if (status.exitCode !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process ${pid} remained present after its leader exited`);
}
