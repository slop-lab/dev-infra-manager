import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shutdownHost } from "../../../../core/packages/core/src/hostLifecycle.js";
import type { LifecycleOptions } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

describe("host lifecycle", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-host-lifecycle-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stops managed infrastructure without removing containers or volumes", async () => {
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        if (args.includes("inspect")) {
          return { command, args, stdout: "true|true\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "container" && args[1] === "ls") {
          return { command, args, stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "stop") {
          return { command, args, stdout: `${args[1]}\n`, stderr: "", exitCode: 0 };
        }
        return { command, args, stdout: "", stderr: "unexpected command", exitCode: 1 };
      },
      async runStreaming() {
        throw new Error("no workspace should be stopped in this test");
      }
    };
    const options = { stateRoot: root } as LifecycleOptions;

    const result = await shutdownHost(runner, options);

    expect(result.phase).toBe("stopped");
    expect(calls.filter((call) => call[1] === "stop").map((call) => call[2])).toEqual([
      "dim-registry-cache",
      "dim-gitea"
    ]);
    expect(calls.flat().join(" ")).not.toMatch(/\b(?:rm|remove|down|prune)\b/);
    expect(calls.flat().join(" ")).not.toContain("volume");
  });
});
