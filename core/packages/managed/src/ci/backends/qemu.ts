import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyAndMaterializeCandidate } from "../candidate.js";
import { NativeOutputCollector, executionDiagnostics } from "../output.js";
import { cleanupNativeContainer, containerName, ownershipLabels, prepareExecutionImage } from "./containers.js";
import type { BackendInput, ExecutionBackend } from "../backend.js";
import type { ExecutionResult } from "../execution.js";

export const qemuBackend: ExecutionBackend = {
  kind: "qemu",
  async run(input) {
    if (input.grant.event.executionKind !== "qemu") throw new Error("execution runtime does not match backend");
    const descriptor = input.grant.descriptor, startedAt = new Date().toISOString();
    const timeout = AbortSignal.timeout(Number(descriptor.bounds.wallClockSeconds) * 1_000), stop = new AbortController();
    const signal = AbortSignal.any([input.signal, timeout, stop.signal]);
    const output = new NativeOutputCollector(Number(descriptor.bounds.outputBytes), () => stop.abort());
    let completion: ExecutionResult["completion"] = { kind: "executor-failure", code: "execution-failed" };
    try {
      const job = join(input.root, "job"), workspace = join(input.root, "workspace"), script = join(job, "script");
      await mkdir(job, { mode: 0o700 });
      await verifyAndMaterializeCandidate({ descriptor, descriptorDigest: input.grant.descriptorDigest,
        authority: input.authority, workspace, scriptFile: script, signal });
      await writeFile(join(job, "descriptor.json"), JSON.stringify(descriptor), { mode: 0o444, flag: "wx" });
      // Public candidate bytes are readable by guest UID 1000 beneath the private host root.
      await chmod(job, 0o755); await chmod(script, 0o444);
      const kvm = await stat("/dev/kvm"), uid = process.getuid?.(), gid = process.getgid?.();
      if (!kvm.isCharacterDevice() || uid === undefined || gid === undefined) throw new Error("KVM is required");
      await prepareExecutionImage(input.runner, descriptor.runnerBaseImage, signal);
      await prepareExecutionImage(input.runner, descriptor.jobImage, signal);
      const launched = await input.runner.run("docker", qemuContainerArguments(input, { uid, gid, kvmGroup: kvm.gid }), { signal });
      if (launched.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(launched.stdout.trim())) throw new Error("QEMU supervisor launch failed");
      const id = launched.stdout.trim();
      const [waited, logs] = await Promise.all([
        input.runner.run("docker", ["wait", id], { signal }),
        input.runner.runStreaming("docker", ["logs", "--follow", id], { signal, stdout: output.stdout, stderr: output.stderr })
      ]);
      const exitCode = /^(?:0|[1-9][0-9]{0,2})\n?$/.test(waited.stdout) ? Number(waited.stdout.trim()) : -1;
      completion = waited.exitCode === 0 && logs === 0 && exitCode >= 0 && exitCode <= 255
        ? { kind: "exited", exitCode } : { kind: "executor-failure", code: "supervisor-observer-failed" };
    } catch { completion = { kind: "executor-failure", code: "qemu-execution-failed" }; }
    finally { if (!await cleanupNativeContainer(input.runner, input.grant, "qemu")) throw new Error("owned QEMU cleanup is uncertain"); }
    if (input.signal.aborted) completion = { kind: "cancelled" };
    else if (output.exceeded) completion = { kind: "output-limit-exceeded" };
    else if (timeout.aborted) completion = { kind: "timed-out" };
    const captured = output.result();
    return { executionId: input.grant.executionId, descriptorDigest: input.grant.descriptorDigest,
      cleanupComplete: true, startedAt, finishedAt: new Date().toISOString(), completion,
      result: completion.kind === "cancelled" ? "cancelled" : completion.kind === "exited" && "exitCode" in completion
        && completion.exitCode === 0 ? "success" : "failure", stdout: captured.stdoutEvidence, stderr: captured.stderrEvidence, logs: executionDiagnostics(captured) };
  },
  cleanup: (runner, grant) => cleanupNativeContainer(runner, grant, "qemu")
};
export function qemuContainerArguments(input: Pick<BackendInput, "grant" | "root">,
  identity: { uid: number; gid: number; kvmGroup: number }): string[] {
  const descriptor = input.grant.descriptor;
  const supervisorMemory = BigInt(descriptor.bounds.memoryBytes) + 256n * 1024n * 1024n;
  return ["run", "--detach", "--name", containerName(input.grant), "--read-only", "--network", "none",
    "--user", `${identity.uid}:${identity.gid}`, "--group-add", String(identity.kvmGroup),
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--device", "/dev/kvm:/dev/kvm",
    "--cpus", descriptor.bounds.cpu, "--memory", String(supervisorMemory), "--pids-limit", descriptor.bounds.pids,
    ...ownershipLabels(input.grant, "qemu").flatMap((label) => ["--label", label]),
    "--mount", `type=bind,src=${join(input.root, "job")},dst=/run/dim/job,readonly`,
    "--mount", `type=bind,src=${join(input.root, "workspace")},dst=/run/dim/workspace`,
    "--mount", `type=image,src=${descriptor.jobImage},dst=/run/dim/guest-root`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m", descriptor.runnerBaseImage,
    "/usr/local/bin/dim-native-qemu-run", "/run/dim/job/descriptor.json", "/run/dim/job/script", "/run/dim/workspace",
    descriptor.jobImage, descriptor.bounds.cpu, descriptor.bounds.memoryBytes, descriptor.bounds.pids];
}
