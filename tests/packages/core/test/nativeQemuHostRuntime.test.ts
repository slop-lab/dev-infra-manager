import { describe, expect, it } from "vitest";
import { assertNativeQemuKvmAvailable, assertNativeQemuRunnerAvailable } from "../../../../core/packages/managed/src/nativeQemuHostRuntime.js";
import type { RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

const ready = '{"return":{},"id":"caps"}\n{"return":{"enabled":true,"present":true},"id":"kvm"}\n{"return":{},"id":"quit"}\n';

type StreamingCall = {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunOptions;
};

class ProbeRunner implements StreamingCommandRunner {
  readonly calls: StreamingCall[] = [];
  private containerName = "";
  private ownershipLabel = "";

  constructor(
    private readonly probeStdout: string,
    private readonly probeExitCode = 0,
    private readonly probeStderr = ""
  ) {}

  async run(): Promise<never> {
    throw new Error("readiness probes must use process-group-aware streaming execution");
  }

  async runStreaming(command: string, args: string[], options: RunOptions = {}): Promise<number> {
    this.calls.push({ command, args, options });
    if (args.includes("run")) {
      this.containerName = option(args, "--name");
      this.ownershipLabel = option(args, "--label");
      options.stdout?.write(this.probeStdout);
      options.stderr?.write(this.probeStderr);
      return this.probeExitCode;
    }
    if (args.includes("inspect")) {
      options.stdout?.write(`${"1".repeat(64)}|/${this.containerName}|${this.ownershipLabel.slice(this.ownershipLabel.indexOf("=") + 1)}\n`);
      return 0;
    }
    if (args.includes("rm")) return 0;
    options.stdout?.write(this.probeStdout);
    options.stderr?.write(this.probeStderr);
    return this.probeExitCode;
  }
}

describe("native QEMU host runtime", () => {
  it.each(["", "not-json", '{"return":{"enabled":true,"present":true},"id":"kvm"}\n',
    ready.replace('"enabled":true', '"enabled":false'), ready + ready])
    ("rejects incomplete, malformed, disabled, or duplicated QMP evidence: %s", async (stdout) => {
      // Given
      const runner = new ProbeRunner(stdout);

      // When / Then
      await expect(assertNativeQemuKvmAvailable(runner, new AbortController().signal))
        .rejects.toThrow(/unavailable/);
    });

  it("reports unavailable when the functional KVM probe fails", async () => {
    // Given
    const runner = new ProbeRunner("", 1, "Could not access KVM kernel module");

    // When / Then
    await expect(assertNativeQemuKvmAvailable(runner, AbortSignal.timeout(1_000)))
      .rejects.toThrow(/unavailable.*KVM/i);
  });

  it("streams QMP into a five-second SIGKILL-only host probe", async () => {
    // Given
    const runner = new ProbeRunner(ready);

    // When
    await assertNativeQemuKvmAvailable(runner, AbortSignal.timeout(1_000));

    // Then
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.command).toBe("timeout");
    expect(runner.calls[0]?.args).toEqual(["-s", "KILL", "5", "qemu-system-x86_64", "-enable-kvm",
      "-machine", "none", "-nodefaults", "-display", "none", "-qmp", "stdio"]);
    expect(runner.calls[0]?.options.stdin).toBeDefined();
    expect(runner.calls[0]?.options.stdout).toBeDefined();
  });

  it("bounds the complete runner probe and cleans the inspected owned ID", async () => {
    // Given
    const runner = new ProbeRunner(ready);
    const image = `registry.example/qemu-runner@sha256:${"1".repeat(64)}`;
    const jobImage = `registry.example/qemu-job@sha256:${"2".repeat(64)}`;

    // When
    await assertNativeQemuRunnerAvailable(runner, image, jobImage, AbortSignal.timeout(1_000));

    // Then
    const run = runner.calls[0];
    expect(run?.command).toBe("timeout");
    expect(run?.args.slice(0, 5)).toEqual(["-s", "KILL", "10", "docker", "run"]);
    expect(run?.args).toContain("--name");
    expect(run?.args).toContain("--label");
    expect(run?.args).toContain("-i");
    expect(run?.args).not.toContain("--rm");
    expect(run?.args.at(-1)).toContain("test -x /usr/local/bin/dim-native-qemu-run");
    expect(run?.args.at(-1)).toContain("test -d /run/dim/guest-root/workspace");
    expect(run?.args.at(-2)).toBe("dim-native-qemu-readiness");
    expect(run?.args).not.toContain("sysbox-runc");
    const inspect = runner.calls[1];
    expect(inspect?.args).toContain("inspect");
    expect(inspect?.args.at(-1)).toBe(option(run?.args ?? [], "--name"));
    expect(runner.calls[2]?.args).toEqual(["-s", "KILL", "5", "docker", "container", "rm", "--force", "1".repeat(64)]);
  });

  it("reports unavailable when the trusted runner image probe fails", async () => {
    // Given
    const runner = new ProbeRunner("", 1, "missing launcher");

    // When / Then
    await expect(assertNativeQemuRunnerAvailable(runner, `runner@sha256:${"2".repeat(64)}`,
      `job@sha256:${"3".repeat(64)}`, AbortSignal.timeout(1_000)))
      .rejects.toThrow(/runner image.*unavailable/i);
  });

  it("reports unavailable when Docker rejects the job image mount", async () => {
    // Given
    const runner = new ProbeRunner("", 125, "invalid mount config for type image");

    // When / Then
    await expect(assertNativeQemuRunnerAvailable(runner, `runner@sha256:${"4".repeat(64)}`,
      `job@sha256:${"5".repeat(64)}`, AbortSignal.timeout(1_000)))
      .rejects.toThrow(/runner image.*unavailable/i);
  });
});

function option(args: readonly string[], name: string): string {
  const value = args[args.indexOf(name) + 1];
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}
