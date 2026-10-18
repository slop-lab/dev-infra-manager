import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assertNativeQemuKvmAvailable, assertNativeQemuRunnerAvailable } from "../../../../core/packages/managed/src/nativeQemuHostRuntime.js";
import { ProcessRunner } from "../../../../core/packages/core/src/runner.js";
import type { RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

type ProcessHarness = {
  readonly runner: StreamingCommandRunner;
  readonly containerState: string;
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function processHarness(mode: string): Promise<ProcessHarness> {
  const root = await mkdtemp("/tmp/dim-kvm-probe-test-");
  roots.push(root);
  const fixture = fileURLToPath(new URL("./fixtures/nativeKvmProbeProcess.mjs", import.meta.url));
  for (const command of ["qemu-system-x86_64", "docker"]) {
    const path = join(root, command);
    await writeFile(path, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' '${command === "docker" ? "docker" : "qemu"}' "$@"\n`, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  const processRunner = new ProcessRunner();
  const containerState = join(root, "container.json");
  const options = (input: RunOptions): RunOptions => ({
    ...input,
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      DIM_KVM_PROBE_TEST_MODE: mode,
      DIM_KVM_PROBE_CONTAINER_STATE: containerState
    }
  });
  return {
    containerState,
    runner: {
      run: (command, args, input = {}) => processRunner.run(command, args, options(input)),
      runStreaming: (command, args, input = {}) => processRunner.runStreaming(command, args, options(input))
    }
  };
}

describe("native KVM readiness process lifecycle", () => {
  it("completes the host QMP protocol normally", async () => {
    // Given
    const { runner } = await processHarness("ready");
    const signal = AbortSignal.timeout(1_000);

    // When
    await assertNativeQemuKvmAvailable(runner, signal);

    // Then
    expect(signal.aborted).toBe(false);
  });

  it("rejects external cancellation after valid replies when SIGTERM exits zero", async () => {
    // Given
    const { runner } = await processHarness("valid-hang");

    // When / Then
    await expect(assertNativeQemuKvmAvailable(runner, AbortSignal.timeout(100))).rejects.toThrow();
  });

  it("rejects a normal QMP exit when KVM is disabled", async () => {
    // Given
    const { runner } = await processHarness("disabled");

    // When / Then
    await expect(assertNativeQemuKvmAvailable(runner, AbortSignal.timeout(1_000))).rejects.toThrow();
  });

  it("rejects an already cancelled host probe before starting QEMU", async () => {
    // Given
    let started = false;
    const runner: StreamingCommandRunner = {
      async run(command, args) { started = true; return { command, args, stdout: "", stderr: "", exitCode: 0 }; },
      async runStreaming() { started = true; return 0; }
    };

    // When / Then
    await expect(assertNativeQemuKvmAvailable(runner, AbortSignal.abort())).rejects.toThrow();
    expect(started).toBe(false);
  });

  it("kills a host probe that emits valid replies and then hangs", async () => {
    // Given
    const { runner } = await processHarness("valid-hang");

    // When / Then
    await expect(assertNativeQemuKvmAvailable(runner, new AbortController().signal))
      .rejects.toThrow(/unavailable/);
  }, 8_000);

  it("removes the exact owned runner probe container after normal completion", async () => {
    // Given
    const { runner, containerState } = await processHarness("ready");

    // When
    await assertNativeQemuRunnerAvailable(runner, "runner", "job", AbortSignal.timeout(2_000));

    // Then
    await expect(access(containerState)).rejects.toThrow();
  });

  it("rejects runner cancellation after valid replies and still cleans up", async () => {
    // Given
    const { runner, containerState } = await processHarness("valid-hang");

    // When / Then
    await expect(assertNativeQemuRunnerAvailable(runner, "runner", "job", AbortSignal.timeout(100)))
      .rejects.toThrow();
    await expect(access(containerState)).rejects.toThrow();
  });

  it("kills a runner probe that emits valid replies and then hangs", async () => {
    // Given
    const { runner, containerState } = await processHarness("valid-hang");

    // When / Then
    await expect(assertNativeQemuRunnerAvailable(runner, "runner", "job", new AbortController().signal))
      .rejects.toThrow(/unavailable/);
    await expect(access(containerState)).rejects.toThrow();
  }, 14_000);

  it("kills the outer Docker process when it hangs after a valid inner probe", async () => {
    // Given
    const { runner, containerState } = await processHarness("docker-hang");

    // When / Then
    await expect(assertNativeQemuRunnerAvailable(runner, "runner", "job", new AbortController().signal))
      .rejects.toThrow(/unavailable/);
    await expect(access(containerState)).rejects.toThrow();
  }, 14_000);

  it("rejects an already cancelled runner probe before starting Docker", async () => {
    // Given
    let started = false;
    const runner: StreamingCommandRunner = {
      async run(command, args) { started = true; return { command, args, stdout: "", stderr: "", exitCode: 0 }; },
      async runStreaming() { started = true; return 0; }
    };

    // When / Then
    await expect(assertNativeQemuRunnerAvailable(runner, "runner", "job", AbortSignal.abort()))
      .rejects.toThrow();
    expect(started).toBe(false);
  });

  it("rejects runner readiness when owned container removal fails", async () => {
    // Given
    const { runner, containerState } = await processHarness("cleanup-failure");

    // When / Then
    await expect(assertNativeQemuRunnerAvailable(runner, "runner", "job", AbortSignal.timeout(2_000)))
      .rejects.toThrow(/runner image.*unavailable/i);
    await expect(access(containerState)).resolves.toBeUndefined();
  });

  it("rejects a foreign-labeled probe container without removing it", async () => {
    // Given
    const { runner, containerState } = await processHarness("foreign-label");

    // When / Then
    await expect(assertNativeQemuRunnerAvailable(runner, "runner", "job", AbortSignal.timeout(2_000)))
      .rejects.toThrow(/runner image.*unavailable/i);
    await expect(access(containerState)).resolves.toBeUndefined();
  });
});
