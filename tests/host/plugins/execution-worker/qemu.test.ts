import { expect, it } from "vitest";
import { qemuContainerArguments, qemuBackend } from "../../../../packages/host/plugins/execution-worker/src/backends/qemu.js";
import { assignment, grant, event } from "../../../contracts/ci/executionFixture.js";
it("routes QEMU through a bounded unprivileged KVM supervisor with public candidate mounts", () => {
  const selected = assignment(), authorized = grant({ ...selected, event: event("integration", "qemu") });
  const args = qemuContainerArguments({ grant: authorized, root: "/private/job" }, { uid: 1000, gid: 1000, kvmGroup: 108 });
  const option = (name: string) => args[args.indexOf(name) + 1];
  expect(qemuBackend.kind).toBe("qemu"); expect(option("--device")).toBe("/dev/kvm:/dev/kvm");
  expect(option("--network")).toBe("bridge"); expect(option("--cap-drop")).toBe("ALL");
  expect(option("--oom-score-adj")).toBe("500");
  expect(option("--cpus")).toBe(authorized.profile.bounds.cpu);
  expect(BigInt(option("--memory")!)).toBe(BigInt(authorized.profile.bounds.memoryBytes) + 256n * 1024n * 1024n);
  expect(args).toContain("type=bind,src=/private/job/job,dst=/run/dim/job,readonly");
  expect(args.join(" ")).not.toMatch(/docker\.sock|--privileged|--env|password|credential/);
});

it("retains failed trusted acquisition diagnostics without starting QEMU or changing cleanup", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ExecutorRunner } = await import("./sysboxFixture.js");
  const { acquisitionOperation } = await import("../../../../packages/host/plugins/execution-worker/src/acquisitionDiagnostics.js");
  const { NativeGitProcessError } = await import("../../../../packages/host/plugins/execution-worker/src/nativeGitCandidateProcess.js");
  const runner = new ExecutorRunner(), original = runner.run.bind(runner);
  runner.run = async (command, args, options) => args[0] === "image" && args.at(-1)?.includes("Config.Labels")
    ? { command, args, stdout: "null", stderr: "", exitCode: 0 } : original(command, args, options);
  const root = await mkdtemp(join(tmpdir(), "dim-qemu-acquisition-"));
  try {
    const selected = grant({ ...assignment(), event: event("practical", "qemu") });
    const result = await qemuBackend.run({ grant: selected, root, runner, signal: new AbortController().signal,
      acquireCandidate: () => acquisitionOperation("source-context-fetch", async () => {
        throw new NativeGitProcessError("private token URL stderr", "timeout");
      }) });
    expect(result.completion).toEqual({ kind: "executor-failure", code: "candidate-read-timeout" });
    expect(result.cleanupComplete).toBe(true);
    expect(JSON.parse(await readFile(join(root, "output", "stderr"), "utf8"))).toEqual({ component: "candidate-acquisition", phase: "source-context-fetch", code: "candidate-read-timeout" });
    expect(JSON.stringify(result)).not.toContain("private token");
    expect(runner.calls.some(({ args }) => args[0] === "run" || args[0] === "wait")).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
