import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shutdownHost } from "../../../../core/packages/core/src/hostLifecycle.js";
import type { StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { hostLifecycleOptions } from "./hostLifecycleFixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("host mirror shutdown ownership", () => {
  it("leaves cache containers with arbitrary legacy labels untouched", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-host-mirror-shutdown-"));
    roots.push(root);
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        if (args[0] === "container" && args[1] === "ls") {
          return { command, args, stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "container" && args[1] === "inspect") {
          const resource = args[2] === "dim-apt-cache" ? "apt-cache" : "registry-cache";
          return {
            command,
            args,
            stdout: `foreign-${resource}|true|dim|legacy-service|${resource}|legacy-resource|true\n`,
            stderr: "",
            exitCode: 0
          };
        }
        if (args[0] === "stop") {
          return { command, args, stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error(`unexpected command: ${[command, ...args].join(" ")}`);
      },
      async runStreaming() {
        throw new Error("no workspace should be stopped");
      }
    };
    const options = {
      ...hostLifecycleOptions(root),
      giteaConnection: { kind: "external" as const, file: "/run/dim/gitea.json" }
    };

    // When
    const result = shutdownHost(runner, options);

    // Then
    await expect(result).rejects.toThrow(/host mirror ownership/);
    expect(calls.some((call) => call[1] === "stop")).toBe(false);
  });
});
