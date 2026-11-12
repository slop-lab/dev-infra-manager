import { acquisitionOperation, writeAcquisitionDiagnostic } from "../acquisitionDiagnostics.js";
import type { HostExecutionRouting } from "@slop-lab/dim-host-core/plugin-api";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { ExecutionResult } from "@slop-lab/dim-contracts-ci/aggregate";
import { cleanupNativeContainer, nativeContainerArgs, nativeRunnerScript, prepareNativeImages } from "./containers.js";
import type { ExecutionBackend } from "../backend.js";
import { NativeOutputCollector, executionDiagnostics, type NativeBoundedOutput } from "../output.js";
import { candidateFailureCode } from "../candidate-failure.js";
import { randomUUID } from "node:crypto";
import { exportContainerArtifacts } from "./container-artifacts.js";
import type { BackendArtifactSource } from "../artifact-source.js";

export function createSysboxBackend(routing?: HostExecutionRouting): ExecutionBackend {
  return {
  kind: "ordinary-sysbox",
  async run(input) {
    if (input.grant.event.executionKind !== "ordinary-sysbox") throw new Error("execution runtime does not match backend");
    const claim = input.grant;
    const descriptor = input.grant.descriptor;
    const workspace = join(input.root, "workspace"), script = join(input.root, "script");
    const launcher = join(input.root, "runner.bash"), daemonConfig = join(input.root, "daemon.json");
    const startedAt = new Date().toISOString();
    const stop = new AbortController();
    const timeout = AbortSignal.timeout(bound(descriptor.bounds.wallClockSeconds) * 1_000);
    const signal = AbortSignal.any([input.signal, stop.signal, timeout]);
    const output = new NativeOutputCollector(bound(descriptor.bounds.outputBytes), () => stop.abort(), join(input.root, "output"));
    let captured: NativeBoundedOutput;
    let completion: ExecutionResult["completion"] = { kind: "executor-failure", code: "execution-failed" };
    let failureCode = "candidate-acquisition-failed";
    const nonce = input.artifactNonce ?? randomUUID();
    let id: string | undefined, artifactSource: BackendArtifactSource = { kind: "archive", nonce, index: [] };
    try {
      await acquisitionOperation("candidate-acquisition", () => input.acquireCandidate({ workspace, scriptFile: script, signal }));
      failureCode = "job-configuration-failed";
      const files = routing?.jobFiles ?? [];
      if (files.length > 16 || new Set(files.map(({ target }) => target)).size !== files.length) throw new Error("invalid host job configuration files");
      const launchScript = nativeRunnerScript(descriptor.repositoryId, files.map(({ target }) => target), routing?.jobEnvironmentDefaults);
      const jobFiles = await Promise.all(files.map(async ({ target, contents }, index) => {
        if (Buffer.byteLength(contents) > 64 * 1024) throw new Error("host job configuration is too large");
        const source = join(input.root, `config-${index}`);
        await writeFile(source, contents, { mode: 0o400, flag: "wx" });
        return { source, target };
      }));
      await writeFile(launcher, launchScript, { mode: 0o500, flag: "wx" });
      await writeFile(daemonConfig, routing?.dockerDaemonConfig ?? "{}\n", { mode: 0o400, flag: "wx" });
      failureCode = "image-preparation-failed";
      await prepareNativeImages(input.runner, claim, signal);
      signal.throwIfAborted();
      failureCode = "container-launch-failed";
      const launched = await input.runner.run("docker", nativeContainerArgs(claim,
        { workspace, script, launcher, daemonConfig, jobFiles }, routing), { signal });
      if (launched.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(launched.stdout.trim())) throw new Error("container launch failed");
      id = launched.stdout.trim();
      failureCode = "container-observer-failed";
      const observations = [
        input.runner.run("docker", ["wait", id], { signal }),
        input.runner.runStreaming("docker", ["logs", "--follow", id], { signal,
          stdout: output.stdout, stderr: output.stderr })
      ] as const;
      try {
        const [waited, logs] = await Promise.all(observations);
        const exitCode = /^(?:0|[1-9][0-9]{0,2})\n?$/.test(waited.stdout) ? Number(waited.stdout.trim()) : -1;
        completion = waited.exitCode === 0 && logs === 0 && exitCode >= 0 && exitCode <= 255
          ? { kind: "exited", exitCode } : { kind: "executor-failure", code: "container-observer-failed" };
      } finally { stop.abort(); await Promise.allSettled(observations); }
    } catch (error) {
      if (id === undefined && failureCode === "container-launch-failed") artifactSource = { kind: "unavailable", nonce, error: "artifact-export-failed" };
      writeAcquisitionDiagnostic(output.stderr, error, candidateFailureCode(error));
      completion = { kind: "executor-failure", code: failureCode === "candidate-acquisition-failed"
        ? candidateFailureCode(error) ?? failureCode : failureCode };
    } finally {
      try {
        try { if (id !== undefined) artifactSource = await exportContainerArtifacts(input, id, nonce); }
        finally { if (!await cleanupNativeContainer(input.runner, claim, "sysbox", id)) throw new Error("owned Sysbox cleanup is uncertain"); }
      } finally { captured = output.result(); }
    }
    if (input.signal.aborted) completion = { kind: "cancelled" };
    else if (output.exceeded) completion = { kind: "output-limit-exceeded" };
    else if (timeout.aborted) completion = { kind: "timed-out" };
    return { executionId: input.grant.executionId, descriptorDigest: input.grant.descriptorDigest,
      cleanupComplete: true, startedAt, finishedAt: new Date().toISOString(), completion,
      result: completion.kind === "cancelled" ? "cancelled"
        : completion.kind === "exited" && "exitCode" in completion && completion.exitCode === 0 ? "success" : "failure",
      stdout: captured.stdoutEvidence, stderr: captured.stderrEvidence, logs: executionDiagnostics(captured), artifactSource };
  },
  cleanup: (runner, grant) => cleanupNativeContainer(runner, grant)
  };
}
export const sysboxBackend = createSysboxBackend();
function bound(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > Number.MAX_SAFE_INTEGER / 1_000) throw new Error("execution bound exceeds runner range");
  return number;
}
