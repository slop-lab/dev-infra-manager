import { prepareHardwareSsh, publishHardwareSsh, hardwareSshPort } from "../hardwareSsh.js";
import { acquisitionOperation, writeAcquisitionDiagnostic } from "../acquisitionDiagnostics.js";
import type { HostExecutionRouting } from "@slop-lab/dim-host-core/plugin-api";
import { chmod, mkdir, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeOutputCollector, executionDiagnostics } from "../output.js";
import { cleanupNativeContainer, containerName, ownershipLabels, prepareExecutionImage, jobEnvironmentScript, validateJobConfigTargets } from "./containers.js";
import type { BackendInput, ExecutionBackend } from "../backend.js";
import type { ExecutionResult } from "@slop-lab/dim-contracts-ci/aggregate";
import { candidateFailureCode } from "../candidate-failure.js";
import { hardwareRunnerLabel, requireHardwareProfile } from "../hardwareProfile.js";
import { publishPublicJobFiles } from "../publicJobFiles.js";

export function createQemuBackend(routing?: HostExecutionRouting): ExecutionBackend { return {
  kind: "qemu",
  async run(input) {
    if (input.grant.event.executionKind !== "qemu") throw new Error("execution runtime does not match backend");
    const descriptor = input.grant.descriptor, startedAt = new Date().toISOString();
    const timeout = AbortSignal.timeout(Number(descriptor.bounds.wallClockSeconds) * 1_000), stop = new AbortController();
    const signal = AbortSignal.any([input.signal, timeout, stop.signal]);
    const output = new NativeOutputCollector(Number(descriptor.bounds.outputBytes), () => stop.abort(), join(input.root, "output"));
    let completion: ExecutionResult["completion"] = { kind: "executor-failure", code: "execution-failed" };
    try {
      await prepareExecutionImage(input.runner, descriptor.runnerBaseImage, signal);
      await prepareExecutionImage(input.runner, descriptor.jobImage, signal);
      const profileInfo = await input.runner.run("docker", ["image", "inspect", descriptor.runnerBaseImage, "--format", `{{json (index .Config.Labels "${hardwareRunnerLabel}")}}`], { signal });
      if (profileInfo.exitCode !== 0) throw new Error("trusted QEMU profile inspection failed");
      const hardware = requireHardwareProfile(JSON.parse(profileInfo.stdout), descriptor);
      if (hardware) {
        const disk = await statfs(input.root, { bigint: true });
        if (disk.type === 0x01021994n || disk.bavail * disk.bsize < 80n * 1024n ** 3n) throw new Error("hardware worker state requires 80 GiB free on disk, not tmpfs");
        await mkdir(join(input.root, "hardware"), { mode: 0o700 });
        await prepareHardwareSsh(join(input.root, "hardware"), input.runner, signal);
      }
      const job = join(input.root, "job"), workspace = join(input.root, "workspace"), script = join(job, "script");
      await mkdir(job, { mode: 0o700 });
      await acquisitionOperation("candidate-acquisition", () => input.acquireCandidate({ workspace, scriptFile: script, signal, ...(hardware ? { sourceContextDirectory: join(job, "source-context") } : {}) }));
      await writeFile(join(job, "working-directory"), `/workspace/${descriptor.repositoryId}`, { mode: 0o444, flag: "wx" });
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
      const imageInfo = await input.runner.run("docker", ["image", "inspect", descriptor.jobImage, "--format", "{{json .Config.Env}}"], { signal });
      if (imageInfo.exitCode !== 0) throw new Error("QEMU job image environment inspection failed");
      const imageEnvironment: unknown = JSON.parse(imageInfo.stdout);
      if (imageEnvironment !== null && (!Array.isArray(imageEnvironment) || !imageEnvironment.every((entry) => typeof entry === "string"))) {
        throw new Error("invalid QEMU job image environment");
      }
      await writeFile(join(job, "job-environment"), jobEnvironmentScript(routing?.jobEnvironmentDefaults, imageEnvironment ?? []) + "export DIM_ARTIFACTS_DIR=/workspace/.dim-ci-artifacts\n", { mode: 0o444, flag: "wx" });
      if (!hardware) {
      const archive = await input.runner.run("docker", ["create", "--name", rootfsContainerName(input.grant), "--network", "none", "--read-only", "--entrypoint", "/bin/bash",
        ...ownershipLabels(input.grant, "qemu-rootfs").flatMap((label) => ["--label", label]), descriptor.jobImage], { signal });
      if (archive.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(archive.stdout.trim())) throw new Error("QEMU root filesystem preparation failed");
      const exported = await input.runner.run("docker", ["export", "--output", join(job, "rootfs.tar"), archive.stdout.trim()], { signal });
      if (exported.exitCode !== 0) throw new Error("QEMU root filesystem export failed");
      await chmod(join(job, "rootfs.tar"), 0o444);
      if (!await cleanupNativeContainer(input.runner, input.grant, "qemu-rootfs", rootfsContainerName(input.grant))) throw new Error("QEMU image preparation cleanup is uncertain");
      }
      await publishPublicJobFiles(job);
      const launched = await input.runner.run("docker", qemuContainerArguments(input, { uid, gid, kvmGroup: kvm.gid }, routing, hardware), { signal });
      if (launched.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(launched.stdout.trim())) throw new Error("QEMU supervisor launch failed");
      const id = launched.stdout.trim();
      if (hardware) await publishHardwareSsh(join(input.root, "hardware"), input.grant, input.runner, signal);
      const [waited, logs] = await Promise.all([
        input.runner.run("docker", ["wait", id], { signal }),
        input.runner.runStreaming("docker", ["logs", "--follow", id], { signal, stdout: output.stdout, stderr: output.stderr })
      ]);
      const exitCode = /^(?:0|[1-9][0-9]{0,2})\n?$/.test(waited.stdout) ? Number(waited.stdout.trim()) : -1;
      completion = waited.exitCode === 0 && logs === 0 && exitCode >= 0 && exitCode <= 255
        ? { kind: "exited", exitCode } : { kind: "executor-failure", code: "supervisor-observer-failed" };
    } catch (error) { writeAcquisitionDiagnostic(output.stderr, error, candidateFailureCode(error)); completion = { kind: "executor-failure", code: candidateFailureCode(error) ?? "qemu-execution-failed" }; }
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
  identity: { uid: number; gid: number; kvmGroup: number }, routing?: HostExecutionRouting, hardware = false): string[] {
  if (hardware && ["host", "none"].includes(routing?.network ?? "bridge")) throw new Error("verification SSH requires an isolated bridge network");
  const descriptor = input.grant.descriptor;
  const supervisorMemory = BigInt(descriptor.bounds.memoryBytes) + 256n * 1024n * 1024n;
  return ["run", "--detach", "--init", "--name", containerName(input.grant), "--read-only", "--network", routing?.network ?? "bridge",
    "--user", `${identity.uid}:${identity.gid}`, "--group-add", String(identity.kvmGroup),
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--device", "/dev/kvm:/dev/kvm",
    "--cpus", descriptor.bounds.cpu, "--memory", String(supervisorMemory), "--pids-limit", descriptor.bounds.pids, "--oom-score-adj", "500",
    ...ownershipLabels(input.grant, "qemu").flatMap((label) => ["--label", label]),
    "--mount", `type=bind,src=${join(input.root, "job")},dst=/run/dim/job,readonly`,
    "--mount", `type=bind,src=${join(input.root, "workspace")},dst=/run/dim/workspace`,
    ...(hardware ? ["--publish", `127.0.0.1::${hardwareSshPort}/tcp`, "--mount", `type=bind,src=${join(input.root, "hardware")},dst=/run/dim/hardware`] : []),
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m", descriptor.runnerBaseImage,
    "/usr/local/bin/dim-native-qemu-run", "/run/dim/job/descriptor.json", "/run/dim/job/script", "/run/dim/workspace",
    descriptor.jobImage, descriptor.bounds.cpu, descriptor.bounds.memoryBytes, descriptor.bounds.pids];
}
