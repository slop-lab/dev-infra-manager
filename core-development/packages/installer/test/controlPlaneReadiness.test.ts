import { describe, expect, it } from "vitest";
import { waitForControlPlaneServiceReady } from "../../../../core/packages/installer/src/controlPlaneReadiness.js";
import type { ControlPlaneConfig } from "../../../../core/packages/installer/src/controlPlaneConfig.js";
import type { ControlPlaneDockerRunner } from "../../../../core/packages/installer/src/controlPlaneDockerTypes.js";

const config: ControlPlaneConfig = {
  schemaVersion: 1,
  deploymentId: "main",
  nativeGit: {
    image: `registry.example/native@sha256:${"a".repeat(64)}`,
    configFile: "/native.json",
    readinessTokenFile: "/native.token",
    publish: { host: "127.0.0.1", port: 7443 }
  },
  ordinaryCi: {
    image: `registry.example/ordinary@sha256:${"b".repeat(64)}`,
    configFile: "/ordinary.json",
    readinessTokenFile: "/ordinary.token",
    publish: { host: "127.0.0.1", port: 7410 }
  }
};

describe("control-plane container-local readiness", () => {
  it("rejects a retry deadline above sixty seconds before any Docker command", async () => {
    // Given
    const calls: string[] = [];
    const runner: ControlPlaneDockerRunner = {
      async run(command) {
        calls.push(command.args.join("\0"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    // When
    const action = waitForControlPlaneServiceReady({
      runner,
      target: {
        config,
        generationPath: "/state/generations/fixture",
        generationId: "a".repeat(64)
      },
      service: "ordinary-ci",
      policy: { timeoutMilliseconds: 60_001, retryIntervalMilliseconds: 1, execTimeoutMilliseconds: 3_000 }
    });

    // Then
    await expect(action).rejects.toThrow(/readiness policy is invalid/);
    expect(calls).toEqual([]);
  });
});
