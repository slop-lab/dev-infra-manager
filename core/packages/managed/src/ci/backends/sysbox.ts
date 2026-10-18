import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";
import type { ExecutionGrant, ExecutionResult } from "@slop-lab/dim-native-git/execution";
import { verifyAndMaterializeCandidate, type NativeCandidateReadAuthority } from "../../nativeOrdinaryCandidateVerifier.js";
import { cleanupNativeContainer, nativeContainerArgs, nativeRunnerScript, prepareNativeImages } from "../../nativeOrdinaryExecutorDocker.js";
import { emptyNativeOutput, NativeOutputCollector } from "../../nativeOrdinaryExecutorOutput.js";

export type BackendInput = { readonly grant: ExecutionGrant; readonly root: string;
  readonly runner: StreamingCommandRunner; readonly signal: AbortSignal;
  readonly authority: NativeCandidateReadAuthority };
export interface ExecutionBackend {
  run(input: BackendInput): Promise<ExecutionResult>;
  cleanup(runner: StreamingCommandRunner, grant: ExecutionGrant, root: string): Promise<boolean>;
}
export const sysboxBackend: ExecutionBackend = {
  async run(input) {
    const claim = input.grant;
    const descriptor = input.grant.descriptor;
    const workspace = join(input.root, "workspace"), script = join(input.root, "script");
    const launcher = join(input.root, "runner.bash"), daemonConfig = join(input.root, "daemon.json");
    const startedAt = new Date().toISOString();
    const stop = new AbortController();
    const timeout = AbortSignal.timeout(bound(descriptor.bounds.wallClockSeconds) * 1_000);
    const signal = AbortSignal.any([input.signal, stop.signal, timeout]);
    const output = new NativeOutputCollector(bound(descriptor.bounds.outputBytes), () => stop.abort());
    let completion: ExecutionResult["completion"] = { kind: "executor-failure", code: "execution-failed" };
    try {
      await verifyAndMaterializeCandidate({ authority: input.authority, descriptor,
        descriptorDigest: input.grant.descriptorDigest, workspace, scriptFile: script, signal });
      await writeFile(launcher, nativeRunnerScript(), { mode: 0o500, flag: "wx" });
      await writeFile(daemonConfig, "{}\n", { mode: 0o400, flag: "wx" });
      await prepareNativeImages(input.runner, claim, signal);
      signal.throwIfAborted();
      const launched = await input.runner.run("docker", nativeContainerArgs(claim,
        { workspace, script, launcher, daemonConfig }), { signal });
      if (launched.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(launched.stdout.trim())) throw new Error("container launch failed");
      const id = launched.stdout.trim();
      const [waited, logs] = await Promise.all([
        input.runner.run("docker", ["wait", id], { signal }),
        input.runner.runStreaming("docker", ["logs", "--follow", id], { signal,
          stdout: output.stdout, stderr: output.stderr })
      ]);
      const exitCode = /^(?:0|[1-9][0-9]{0,2})\n?$/.test(waited.stdout) ? Number(waited.stdout.trim()) : -1;
      completion = waited.exitCode === 0 && logs === 0 && exitCode >= 0 && exitCode <= 255
        ? { kind: "exited", exitCode } : { kind: "executor-failure", code: "container-observer-failed" };
    } catch {
      completion = { kind: "executor-failure", code: "execution-failed" };
    } finally {
      if (!await cleanupNativeContainer(input.runner, claim)) throw new Error("owned Sysbox cleanup is uncertain");
    }
    if (input.signal.aborted) completion = { kind: "cancelled" };
    else if (output.exceeded) completion = { kind: "output-limit-exceeded" };
    else if (timeout.aborted) completion = { kind: "timed-out" };
    const captured = output.result();
    return { executionId: input.grant.executionId, descriptorDigest: input.grant.descriptorDigest,
      cleanupComplete: true, startedAt, finishedAt: new Date().toISOString(), completion,
      result: completion.kind === "cancelled" ? "cancelled"
        : completion.kind === "exited" && "exitCode" in completion && completion.exitCode === 0 ? "success" : "failure",
      stdout: captured.stdoutEvidence, stderr: captured.stderrEvidence };
  },
  cleanup: (runner, grant) => cleanupNativeContainer(runner, grant)
};
function bound(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > Number.MAX_SAFE_INTEGER / 1_000) throw new Error("execution bound exceeds runner range");
  return number;
}
