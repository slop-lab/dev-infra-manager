import { describe, expect, it } from "vitest";
import { assertNativeQemuKvmAvailable, assertNativeQemuRunnerAvailable } from "../../../../core/packages/core/src/nativeQemuHostRuntime.js";
import type { StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

describe("native QEMU host runtime", () => {
  it("reports unavailable when the functional KVM probe fails", async () => {
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        return { command, args, stdout: "", stderr: "Could not access KVM kernel module", exitCode: 1 };
      },
      async runStreaming() { return 0; }
    };
    await expect(assertNativeQemuKvmAvailable(runner, AbortSignal.timeout(1_000)))
      .rejects.toThrow(/unavailable.*KVM/i);
  });

  it("uses enable-kvm and no TCG fallback for the functional probe", async () => {
    const commands: readonly string[][] = [];
    const mutableCommands: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        mutableCommands.push([command, ...args]);
        return { command, args, stdout: "", stderr: "", exitCode: 0 };
      },
      async runStreaming() { return 0; }
    };
    await assertNativeQemuKvmAvailable(runner, AbortSignal.timeout(1_000));
    expect(mutableCommands).toEqual([["qemu-system-x86_64", "-enable-kvm", "-machine", "none",
      "-nodefaults", "-display", "none"]]);
    expect(commands).toEqual([]);
  });

  it("probes the digest-pinned trusted runner launcher and KVM before claims", async () => {
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        return { command, args, stdout: "", stderr: "", exitCode: 0 };
      },
      async runStreaming() { return 0; }
    };
    const image = `registry.example/qemu-runner@sha256:${"1".repeat(64)}`;

    const jobImage = `registry.example/qemu-job@sha256:${"2".repeat(64)}`;
    await assertNativeQemuRunnerAvailable(runner, image, jobImage, AbortSignal.timeout(1_000));

    expect(calls).toEqual([["docker", "run", "--rm", "--read-only", "--network", "none",
      "--device", "/dev/kvm:/dev/kvm", "--mount",
      `type=image,src=${jobImage},dst=/run/dim/guest-root`, "--entrypoint", "/bin/sh", image, "-c",
      "test -x /usr/local/bin/dim-native-qemu-run && test -x /run/dim/guest-root/bin/bash && test -d /run/dim/guest-root/dev && test -d /run/dim/guest-root/proc && test -d /run/dim/guest-root/sys && test -d /run/dim/guest-root/run/dim/job && test -d /run/dim/guest-root/workspace && exec qemu-system-x86_64 -enable-kvm -machine none -nodefaults -display none"]]);
    expect(calls[0]).not.toContain("sysbox-runc");
  });

  it("reports unavailable when the trusted runner image probe fails", async () => {
    const runner: StreamingCommandRunner = {
      async run(command, args) { return { command, args, stdout: "", stderr: "missing launcher", exitCode: 1 }; },
      async runStreaming() { return 0; }
    };

    await expect(assertNativeQemuRunnerAvailable(runner, `runner@sha256:${"2".repeat(64)}`,
      `job@sha256:${"3".repeat(64)}`,
      AbortSignal.timeout(1_000))).rejects.toThrow(/runner image.*unavailable/i);
  });

  it("reports unavailable when Docker rejects the job image mount or required job root", async () => {
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        return { command, args, stdout: "", stderr: "invalid mount config for type image", exitCode: 125 };
      },
      async runStreaming() { return 0; }
    };

    await expect(assertNativeQemuRunnerAvailable(runner, `runner@sha256:${"4".repeat(64)}`,
      `job@sha256:${"5".repeat(64)}`, AbortSignal.timeout(1_000)))
      .rejects.toThrow(/runner image.*unavailable/i);
  });
});
