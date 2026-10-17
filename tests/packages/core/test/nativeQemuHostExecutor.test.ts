import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupNativeQemuAssignment } from "../../../../core/packages/core/src/nativeQemuHostExecutor.js";
import { executeNativeQemuAssignment } from "../../../../core/packages/core/src/nativeQemuHostExecutor.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { qemuAssignment, qemuAuthority, qemuScript } from "./nativeQemuHostFixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, stat: vi.fn((path: string) => path === "/dev/kvm"
    ? Promise.resolve({ gid: 108, isCharacterDevice: () => true }) : original.stat(path)) };
});

describe("native QEMU host cleanup", () => {
  it("removes only containers returned by the exact claim label and then the private root", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "native-qemu-cleanup-")), "claim");
    await mkdir(root, { mode: 0o700 });
    const runner = new CleanupRunner("0123456789ab\nabcdef012345\n");

    expect(await cleanupNativeQemuAssignment(runner, "claim-a", root)).toBe(true);

    expect(runner.calls).toEqual([
      ["docker", "container", "ls", "--all", "--quiet", "--filter", "label=dev.dim.native-qemu.claim=claim-a"],
      ["docker", "container", "rm", "--force", "0123456789ab", "abcdef012345"]
    ]);
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the private root when labelled-container discovery fails", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "native-qemu-cleanup-")), "claim");
    await mkdir(root, { mode: 0o700 });
    const runner = new CleanupRunner("", 1);

    expect(await cleanupNativeQemuAssignment(runner, "claim-b", root)).toBe(false);
    expect((await stat(root)).isDirectory()).toBe(true);
  });
});

describe("native QEMU execution evidence", () => {
  it("records bounded stdout and stderr digests after owned cleanup", async () => {
    // Given
    const stateDirectory = await mkdtemp(join(tmpdir(), "native-qemu-execution-"));
    const runner = new OutputRunner();
    let verifiedAtLaunch = false;
    runner.beforeStreaming = async (args) => {
      const jobMount = args.find((argument) => argument.includes("dst=/run/dim/job,readonly"));
      const workspaceMount = args.find((argument) => argument.includes("dst=/run/dim/workspace"));
      if (jobMount === undefined || workspaceMount === undefined) throw new TypeError("QEMU mounts are missing");
      const jobRoot = jobMount.slice("type=bind,src=".length, -",dst=/run/dim/job,readonly".length);
      const workspace = workspaceMount.slice("type=bind,src=".length, -",dst=/run/dim/workspace".length);
      await expect(readFile(join(jobRoot, "script"))).resolves.toEqual(qemuScript);
      expect((await stat(jobRoot)).mode & 0o777).toBe(0o755);
      expect((await stat(join(jobRoot, "script"))).mode & 0o777).toBe(0o444);
      expect((await stat(join(jobRoot, "descriptor.json"))).mode & 0o777).toBe(0o444);
      expect((await stat(join(jobRoot, ".."))).mode & 0o777).toBe(0o700);
      await expect(readFile(join(workspace, "candidate.txt"), "utf8")).resolves.toBe("verified tree\n");
      await writeFile(join(workspace, "guest-output"), "writable\n");
      verifiedAtLaunch = true;
    };

    // When
    const outcome = await executeNativeQemuAssignment({ runner, stateDirectory,
      capacity: { capacity: "kvm-a", runnerBaseImage: `runner@sha256:${"1".repeat(64)}`,
        jobBaseImage: `job@sha256:${"2".repeat(64)}`, supervisorMemoryBytes: "2097152",
        bounds: { cpu: "2", memoryBytes: "1024",
          pids: "64", wallClockSeconds: "60", outputBytes: "4" } },
      assignment: qemuAssignment, createReadAuthority: async () => qemuAuthority(),
      signal: AbortSignal.timeout(1_000) });

    // Then
    const payload = Reflect.get(outcome.terminalEvent, "payload") as Readonly<Record<string, unknown>>;
    expect(payload.stdout).toEqual({ bytes: "4", sha256: "sha256:88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589", truncated: true });
    expect(payload.stderr).toEqual({ bytes: "0", sha256: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", truncated: true });
    expect(runner.streamingArgs).toContain("--memory");
    expect(runner.streamingArgs).toContain("2097152");
    expect(runner.streamingArgs).toEqual(expect.arrayContaining([
      "--user", `${process.getuid?.()}:${process.getgid?.()}`, "--group-add", "108",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges"
    ]));
    expect(runner.streamingArgs).toContain(`type=image,src=job@sha256:${"2".repeat(64)},dst=/run/dim/guest-root`);
    expect(runner.streamingArgs.slice(-7)).toEqual(["/run/dim/job/descriptor.json", "/run/dim/job/script",
      "/run/dim/workspace",
      `job@sha256:${"2".repeat(64)}`, "2", "1048576", "64"]);
    expect(runner.cleaned).toBe(true);
    expect(verifiedAtLaunch).toBe(true);
  });
});

class CleanupRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];
  constructor(private readonly listed: string, private readonly listExitCode = 0) {}
  run(command: string, args: string[], _options?: RunOptions): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    const listing = args[1] === "ls";
    return Promise.resolve({ command, args, stdout: listing ? this.listed : "", stderr: "",
      exitCode: listing ? this.listExitCode : 0 });
  }
  runStreaming(): Promise<number> { return Promise.resolve(0); }
}

class OutputRunner implements StreamingCommandRunner {
  cleaned = false;
  streamingArgs: readonly string[] = [];
  beforeStreaming: ((args: readonly string[]) => Promise<void>) | undefined;
  run(command: string, args: string[]): Promise<CommandResult> {
    const listing = args[1] === "ls";
    if (listing) this.cleaned = true;
    return Promise.resolve({ command, args, stdout: "", stderr: "", exitCode: 0 });
  }
  async runStreaming(_command: string, args: string[], options?: RunOptions): Promise<number> {
    this.streamingArgs = args;
    await this.beforeStreaming?.(args);
    options?.stdout?.write("abcdef");
    options?.stderr?.write("xyz");
    return 0;
  }
}
