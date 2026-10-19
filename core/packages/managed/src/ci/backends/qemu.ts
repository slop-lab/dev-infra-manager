import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyAndMaterializeCandidate } from "../candidate.js";
import { NativeOutputCollector, executionDiagnostics } from "../output.js";
import { cleanupNativeContainer, containerName, ownershipLabels, prepareExecutionImage, validateJobConfigTargets, type NativeHostImageRouting } from "./containers.js";
import type { BackendInput, ExecutionBackend } from "../backend.js";
import type { ExecutionResult } from "../execution.js";

export function createQemuBackend(routing?: NativeHostImageRouting): ExecutionBackend { return {
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
      const files = routing?.jobFiles ?? [];
      validateJobConfigTargets(files.map(({ target }) => target));
      for (const [index, file] of files.entries()) {
        if (Buffer.byteLength(file.contents) > 64 * 1024) throw new Error("host job configuration is too large");
        await writeFile(join(job, `config-${index}`), file.contents, { mode: 0o444, flag: "wx" });
      }
      await writeFile(join(job, "config-targets"), files.map(({ target }, index) => `config-${index} ${target}\n`).join(""), { mode: 0o444, flag: "wx" });
      // Public candidate bytes are readable by guest UID 1000 beneath the private host root.
      await chmod(job, 0o755); await chmod(script, 0o444);
      const kvm = await stat("/dev/kvm"), uid = process.getuid?.(), gid = process.getgid?.();
      if (!kvm.isCharacterDevice() || uid === undefined || gid === undefined) throw new Error("KVM is required");
      await prepareExecutionImage(input.runner, descriptor.runnerBaseImage, signal);
      await prepareExecutionImage(input.runner, descriptor.jobImage, signal);
      const archive = await input.runner.run("docker", ["create", "--name", rootfsContainerName(input.grant), "--network", "none", "--read-only", "--entrypoint", "/bin/bash",
        ...ownershipLabels(input.grant, "qemu-rootfs").flatMap((label) => ["--label", label]), descriptor.jobImage], { signal });
      if (archive.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(archive.stdout.trim())) throw new Error("QEMU root filesystem preparation failed");
      const exported = await input.runner.run("docker", ["export", "--output", join(job, "rootfs.tar"), archive.stdout.trim()], { signal });
      if (exported.exitCode !== 0) throw new Error("QEMU root filesystem export failed");
      await chmod(join(job, "rootfs.tar"), 0o444);
      if (!await cleanupNativeContainer(input.runner, input.grant, "qemu-rootfs", rootfsContainerName(input.grant))) throw new Error("QEMU image preparation cleanup is uncertain");
      const launched = await input.runner.run("docker", qemuContainerArguments(input, { uid, gid, kvmGroup: kvm.gid }, routing), { signal });
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
    finally { if (!await cleanupQemu(input.runner, input.grant)) throw new Error("owned QEMU cleanup is uncertain"); }
    if (input.signal.aborted) completion = { kind: "cancelled" };
    else if (output.exceeded) completion = { kind: "output-limit-exceeded" };
    else if (timeout.aborted) completion = { kind: "timed-out" };
    const captured = output.result();
    return { executionId: input.grant.executionId, descriptorDigest: input.grant.descriptorDigest,
      cleanupComplete: true, startedAt, finishedAt: new Date().toISOString(), completion,
      result: completion.kind === "cancelled" ? "cancelled" : completion.kind === "exited" && "exitCode" in completion
        && completion.exitCode === 0 ? "success" : "failure", stdout: captured.stdoutEvidence, stderr: captured.stderrEvidence, logs: executionDiagnostics(captured) };
  },
  cleanup: cleanupQemu
}; }
export const qemuBackend = createQemuBackend();
function rootfsContainerName(grant: BackendInput["grant"]): string { return `${containerName(grant)}-rootfs`; }
async function cleanupQemu(runner: BackendInput["runner"], grant: BackendInput["grant"]): Promise<boolean> {
  const image = await cleanupNativeContainer(runner, grant, "qemu-rootfs", rootfsContainerName(grant));
  const machine = await cleanupNativeContainer(runner, grant, "qemu");
  return image && machine;
}
export function qemuContainerArguments(input: Pick<BackendInput, "grant" | "root">,
  identity: { uid: number; gid: number; kvmGroup: number }, routing?: NativeHostImageRouting): string[] {
  const descriptor = input.grant.descriptor;
  const supervisorMemory = BigInt(descriptor.bounds.memoryBytes) + 256n * 1024n * 1024n;
  return ["run", "--detach", "--init", "--name", containerName(input.grant), "--read-only", "--network", routing?.network ?? "bridge",
    "--user", `${identity.uid}:${identity.gid}`, "--group-add", String(identity.kvmGroup),
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--device", "/dev/kvm:/dev/kvm",
    "--cpus", descriptor.bounds.cpu, "--memory", String(supervisorMemory), "--pids-limit", descriptor.bounds.pids, "--oom-score-adj", "500",
    ...ownershipLabels(input.grant, "qemu").flatMap((label) => ["--label", label]),
    "--mount", `type=bind,src=${join(input.root, "job")},dst=/run/dim/job,readonly`,
    "--mount", `type=bind,src=${join(input.root, "workspace")},dst=/run/dim/workspace`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m", descriptor.runnerBaseImage,
    "/usr/local/bin/dim-native-qemu-run", "/run/dim/job/descriptor.json", "/run/dim/job/script", "/run/dim/workspace",
    descriptor.jobImage, descriptor.bounds.cpu, descriptor.bounds.memoryBytes, descriptor.bounds.pids];
}
