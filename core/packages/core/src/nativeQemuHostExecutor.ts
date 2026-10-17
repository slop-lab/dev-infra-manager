import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyAndMaterializeNativeQemuCandidate } from "./nativeQemuHostCandidateVerifier.js";
import type { NativeQemuCapacity } from "./nativeQemuSchedulerConfig.js";
import type { NativeQemuHostAssignment } from "./nativeQemuHostClient.js";
import type { NativeCandidateReadAuthority } from "./nativeOrdinaryCandidateVerifier.js";
import { NativeOutputCollector } from "./nativeOrdinaryExecutorOutput.js";
import type { StreamingCommandRunner } from "./types.js";

export type NativeQemuExecutionOutcome = {
  readonly terminalEvent: Readonly<Record<string, unknown>>;
};

export type NativeQemuExecutionCapacity = NativeQemuCapacity & {
  readonly supervisorMemoryBytes: string;
};

export type NativeQemuReadAuthorityFactory = (input: {
  readonly assignment: NativeQemuHostAssignment;
  readonly privateRoot: string;
  readonly signal: AbortSignal;
}) => Promise<NativeCandidateReadAuthority>;

export async function executeNativeQemuAssignment(input: {
  readonly runner: StreamingCommandRunner;
  readonly capacity: NativeQemuExecutionCapacity;
  readonly assignment: NativeQemuHostAssignment;
  readonly stateDirectory: string;
  readonly signal: AbortSignal;
  readonly createReadAuthority: NativeQemuReadAuthorityFactory;
}): Promise<NativeQemuExecutionOutcome> {
  const claimId = stringField(input.assignment.claim, "claimId");
  const root = join(input.stateDirectory, claimId);
  await mkdir(root, { recursive: false, mode: 0o700 });
  const jobRoot = join(root, "job");
  const workspace = join(root, "workspace");
  await mkdir(jobRoot, { mode: 0o700 });
  const scriptPath = join(jobRoot, "script");
  const descriptorPath = join(jobRoot, "descriptor.json");
  const startedAt = new Date().toISOString();
  let exitCode = 1;
  const runController = new AbortController();
  const output = new NativeOutputCollector(Number(input.capacity.bounds.outputBytes), () => runController.abort());
  try {
    const authority = await input.createReadAuthority({ assignment: input.assignment,
      privateRoot: root, signal: input.signal });
    await verifyAndMaterializeNativeQemuCandidate({ authority, descriptor: input.assignment.attempt.descriptor,
      descriptorDigest: input.assignment.attempt.descriptorDigest, workspace, scriptFile: scriptPath,
      signal: input.signal });
    await writeFile(descriptorPath, JSON.stringify(input.assignment.attempt.descriptor), { mode: 0o400, flag: "wx" });
    try {
      input.signal.throwIfAborted();
      const kvm = await stat("/dev/kvm");
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      if (uid === undefined || gid === undefined || !kvm.isCharacterDevice()) {
        throw new NativeQemuHostExecutionError("native QEMU requires a Linux host identity and KVM device");
      }
      exitCode = await input.runner.runStreaming("docker", ["run", "--rm", "--read-only", "--network", "none",
        "--user", `${uid}:${gid}`, "--group-add", String(kvm.gid),
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--device", "/dev/kvm:/dev/kvm", "--cpus", input.capacity.bounds.cpu,
        "--memory", input.capacity.supervisorMemoryBytes, "--pids-limit", input.capacity.bounds.pids,
        "--label", `dev.dim.native-qemu.claim=${claimId}`,
        "--mount", `type=bind,src=${jobRoot},dst=/run/dim/job,readonly`,
        "--mount", `type=bind,src=${workspace},dst=/run/dim/workspace`,
        "--mount", `type=image,src=${input.capacity.jobBaseImage},dst=/run/dim/guest-root`,
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m", input.capacity.runnerBaseImage,
        "/usr/local/bin/dim-native-qemu-run", "/run/dim/job/descriptor.json", "/run/dim/job/script", "/run/dim/workspace",
        input.capacity.jobBaseImage, input.capacity.bounds.cpu,
        input.assignment.attempt.descriptor.bounds.memoryBytes,
        input.capacity.bounds.pids], { signal: AbortSignal.any([input.signal, runController.signal,
          AbortSignal.timeout(Number(input.capacity.bounds.wallClockSeconds) * 1_000)]),
          stdout: output.stdout, stderr: output.stderr });
    } catch (error) {
      if (!output.exceeded) throw error;
    }
  } finally {
    const cleanup = await cleanupNativeQemuAssignment(input.runner, claimId, root);
    if (!cleanup) throw new NativeQemuHostCleanupError(claimId);
  }
  const finishedAt = new Date().toISOString();
  const captured = output.result();
  return { terminalEvent: { schemaVersion: 1, eventId: randomUUID(), occurredAt: finishedAt,
    eventType: "dim.ci.job.completed", payload: { executionKind: "qemu", evidenceClass: "candidate-controlled",
      reviewId: stringField(input.assignment.claim, "event", "reviewId"),
      attemptId: input.assignment.attempt.attemptId, descriptor: input.assignment.attempt.descriptor,
      descriptorDigest: input.assignment.attempt.descriptorDigest,
      hostId: stringField(input.assignment.claim, "hostId"), capacity: stringField(input.assignment.claim, "capacity"),
      startedAt, finishedAt, result: exitCode === 0 ? "success" : "failure",
      completion: { kind: "exited", exitCode }, stdout: captured.stdoutEvidence,
      stderr: captured.stderrEvidence } } };
}

export async function cleanupNativeQemuAssignment(
  runner: StreamingCommandRunner,
  claimId: string,
  root: string
): Promise<boolean> {
  const listed = await runner.run("docker", ["container", "ls", "--all", "--quiet", "--filter",
    `label=dev.dim.native-qemu.claim=${claimId}`]);
  if (listed.exitCode !== 0) return false;
  const containerIds = listed.stdout.split("\n").filter((value) => /^[0-9a-f]{12,64}$/.test(value));
  if (containerIds.length > 0) {
    const removed = await runner.run("docker", ["container", "rm", "--force", ...containerIds]);
    if (removed.exitCode !== 0) return false;
  }
  await rm(root, { recursive: true, force: true });
  return true;
}
function stringField(value: Readonly<Record<string, unknown>>, key: string, nestedKey?: string): string {
  const selected = nestedKey === undefined ? value[key] : typeof value[key] === "object" && value[key] !== null
    ? Reflect.get(value[key], nestedKey) : undefined;
  if (typeof selected !== "string") throw new NativeQemuHostExecutionError("native QEMU assignment is invalid");
  return selected;
}
export class NativeQemuHostExecutionError extends Error { readonly name = "NativeQemuHostExecutionError"; }
export class NativeQemuHostCleanupError extends Error {
  readonly name = "NativeQemuHostCleanupError";
  constructor(readonly claimId: string) { super(`native QEMU claim '${claimId}' cleanup is incomplete`); }
}
