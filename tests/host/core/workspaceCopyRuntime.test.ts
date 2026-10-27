import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { workspaceCopyMarker } from "../../../packages/host/core/src/workspace/copy.js";
import { runContainerWorkspaceCopy } from "../../../packages/host/core/src/workspace/copyRuntime.js";
import type { CommandResult, CommandRunner, StreamingCommandRunner } from "../../../packages/host/core/src/types.js";
import { workspaceRecord } from "../../support/workspaceFixture.js";

it("awaits independent owned-helper cleanup before a cancelled runtime copy returns", async () => {
  const record = workspaceRecord(); const token = randomUUID(); const abort = new AbortController(); abort.abort();
  let releaseCleanup: (() => void) | undefined; let cleanupArgs: string[] = [];
  const runner: StreamingCommandRunner = {
    async run() { throw new Error("copy stream must use runStreaming"); },
    async runStreaming() { return 143; }
  };
  const cleanupRunner: CommandRunner = {
    async run(command, args) {
      cleanupArgs = [command, ...args];
      await new Promise<void>((resolve) => { releaseCleanup = resolve; });
      return result(command, args, 0);
    }
  };
  const copying = runContainerWorkspaceCopy({ runner, cleanupRunner, record, container: "container-id",
    operation: { command: ["copy-helper"], token, path: "relative/target" }, runArguments: ["exec", "container-id", "copy-helper"], options: { signal: abort.signal } });
  while (releaseCleanup === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
  let settled = false; void copying.finally(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve)); expect(settled).toBe(false);
  releaseCleanup(); await expect(copying).resolves.toBe(143);
  expect(cleanupArgs[0]).toBe("docker"); expect(cleanupArgs).toContain("container-id");
  expect(cleanupArgs.slice(-4)).toEqual(["/workspace/relative/target", workspaceCopyMarker, "cleanup", token]);
});

it("fails the copy while retaining the lifecycle lock when owned cleanup cannot be confirmed", async () => {
  const record = workspaceRecord(); const token = randomUUID();
  const runner: StreamingCommandRunner = { async run() { throw new Error("unexpected"); }, async runStreaming() { return 2; } };
  const cleanupRunner: CommandRunner = { async run(command, args) { return result(command, args, 1, "cleanup conflict"); } };
  await expect(runContainerWorkspaceCopy({ runner, cleanupRunner, record, container: "container-id",
    operation: { command: ["copy-helper"], token, path: "/absolute/target" }, runArguments: ["exec"], options: {} }))
    .rejects.toThrow(/cleanup could not be confirmed: cleanup conflict/);
});

function result(command: string, args: string[], exitCode: number, stderr = ""): CommandResult {
  return { command, args, exitCode, stdout: "", stderr };
}
