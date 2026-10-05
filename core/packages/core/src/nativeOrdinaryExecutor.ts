import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeHostVerificationError, verifyAndMaterializeCandidate, type NativeCandidateReadAuthority } from "./nativeOrdinaryCandidateVerifier.js";
import { nativeDescriptorDigest } from "./nativeOrdinaryAuthorityProtocol.js";
import type { NativeHostClaim, NativeHostClaimRenewal, NativeHostClaimRenewalRequest, NativeHostRecoveryRequest } from "./nativeOrdinaryClaimProtocol.js";
import { cleanupNativeContainer, nativeContainerArgs, nativeDaemonConfig, nativeRunnerScript, prepareNativeImages } from "./nativeOrdinaryExecutorDocker.js";
import { NativeHostCleanupError, NativeHostFinalizationUncertainError, NativeHostLaunchError, NativeHostLeaseError, NativeHostRecoveryError } from "./nativeOrdinaryExecutorErrors.js";
import { renewalRequest, startNativeLease, type NativeLease } from "./nativeOrdinaryExecutorLease.js";
import { emptyNativeOutput, NativeOutputCollector, type NativeBoundedOutput } from "./nativeOrdinaryExecutorOutput.js";
import { submitNativeResult } from "./nativeOrdinaryExecutorReport.js";
import type { NativeHostResultRequest, NativeTerminalCompletion, NativeTerminalEvent } from "./nativeOrdinaryResultProtocol.js";
import type { StreamingCommandRunner } from "./types.js";

export type NativeHostExecution = {
  readonly claim: NativeHostClaim;
  readonly signal?: AbortSignal;
};

export type NativeHostExecutionResult = {
  readonly disposition: "reported" | "recovered";
  readonly terminalEvent: NativeTerminalEvent;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
};

export type NativeCandidateReadAuthorityFactoryInput = {
  readonly claim: NativeHostClaim;
  readonly privateRoot: string;
  readonly signal: AbortSignal;
};

export type NativeCandidateReadAuthorityFactory = (
  input: NativeCandidateReadAuthorityFactoryInput
) => NativeCandidateReadAuthority | Promise<NativeCandidateReadAuthority>;

export type NativeHostExecutorDependencies = {
  readonly runner: StreamingCommandRunner;
  readonly createReadAuthority: NativeCandidateReadAuthorityFactory;
  readonly renewClaim: (request: NativeHostClaimRenewalRequest, signal: AbortSignal) => Promise<NativeHostClaimRenewal>;
  readonly reportResult: (request: NativeHostResultRequest, signal: AbortSignal) => Promise<void>;
  readonly recoverClaim: (request: NativeHostRecoveryRequest, signal: AbortSignal) => Promise<void>;
  readonly randomId?: () => string;
  readonly now?: () => Date;
};

export async function executeNativeHostClaim(
  dependencies: NativeHostExecutorDependencies,
  execution: NativeHostExecution
): Promise<NativeHostExecutionResult> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-ordinary-"));
  const workspace = join(root, "workspace");
  const script = join(root, "script");
  const launcher = join(root, "runner.bash");
  const daemonConfig = join(root, "daemon.json");
  const identifiers = dependencies.randomId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());
  const initialSignal = execution.signal ?? new AbortController().signal;
  let signal = initialSignal;
  let containerCleanupArmed = true;
  let lease: NativeLease | undefined;
  let captured: NativeBoundedOutput = emptyNativeOutput();
  const startedAt = now().toISOString();
  try {
    if (nativeDescriptorDigest(execution.claim.descriptor) !== execution.claim.descriptorDigest) {
      throw new NativeHostVerificationError("claim descriptor digest does not match its descriptor");
    }
    lease = await startNativeLease({
      claim: execution.claim,
      renewClaim: dependencies.renewClaim,
      randomId: identifiers,
      signal: initialSignal
    });
    signal = execution.signal === undefined ? lease.signal : AbortSignal.any([execution.signal, lease.signal]);
    const readAuthority = await dependencies.createReadAuthority({
      claim: execution.claim,
      privateRoot: root,
      signal
    });
    await verifyAndMaterializeCandidate({
      authority: readAuthority, descriptor: execution.claim.descriptor,
      descriptorDigest: execution.claim.descriptorDigest, workspace, scriptFile: script, signal
    });
    await writeFile(launcher, nativeRunnerScript(), { mode: 0o500, flag: "wx" });
    await writeFile(daemonConfig, nativeDaemonConfig(), { mode: 0o400, flag: "wx" });
    await prepareNativeImages(dependencies.runner, execution.claim, signal);
    signal.throwIfAborted();
    const launched = await dependencies.runner.run("docker", nativeContainerArgs(execution.claim, {
      workspace, script, launcher, daemonConfig
    }), { signal });
    if (launched.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(launched.stdout.trim())) throw new NativeHostLaunchError();
    const runController = new AbortController();
    const runSignal = AbortSignal.any([signal, runController.signal, AbortSignal.timeout(toMilliseconds(execution.claim.descriptor.bounds.wallClockSeconds))]);
    const output = new NativeOutputCollector(toNumber(execution.claim.descriptor.bounds.outputBytes, "output"), () => runController.abort());
    const containerId = launched.stdout.trim();
    const [waited, logsExitCode] = await Promise.all([
      dependencies.runner.run("docker", ["wait", containerId], { signal: runSignal }),
      dependencies.runner.runStreaming("docker", ["logs", "--follow", containerId], {
        signal: runSignal, stdout: output.stdout, stderr: output.stderr
      })
    ]);
    const completion = classifyCompletion({
      leaseLost: lease.lost, externallyCancelled: execution.signal?.aborted ?? false,
      outputExceeded: output.exceeded, timedOut: runSignal.aborted && !signal.aborted && !runController.signal.aborted,
      exitCode: parseExitCode(waited.stdout), waitObserverExitCode: waited.exitCode, logsObserverExitCode: logsExitCode
    });
    captured = output.result();
    if (!await cleanupNativeContainer(dependencies.runner, execution.claim)) throw new NativeHostCleanupError(execution.claim.claimId);
    containerCleanupArmed = false;
    const finishedAt = now().toISOString();
    const terminalEvent = terminal(execution, completion, captured, startedAt, finishedAt, identifiers());
    if (!lease.isCurrent()) {
      await lease.stop();
      const leaseFailure = lease.failure;
      await Promise.resolve(dependencies.recoverClaim(recoveryRequest(execution.claim, identifiers()), AbortSignal.timeout(30_000))).catch((recoveryError: unknown) => {
        throw new NativeHostRecoveryError(execution.claim.claimId, leaseFailure, recoveryError);
      });
      return { disposition: "recovered", terminalEvent: terminal(execution, { kind: "lease-lost" }, captured, startedAt, finishedAt, identifiers()), stdout: captured.stdout, stderr: captured.stderr };
    }
    const resultRequest: NativeHostResultRequest = {
      schemaVersion: 1, requestId: identifiers(), claimId: execution.claim.claimId, terminalEvent, cleanupComplete: true
    };
    const reportFailure = await submitNativeResult(dependencies.reportResult, resultRequest, lease.signal);
    await lease.stop();
    if (reportFailure !== undefined) {
      if (lease.lost) {
        const leaseFailure = lease.failure;
        await Promise.resolve(dependencies.recoverClaim(recoveryRequest(execution.claim, identifiers()), AbortSignal.timeout(30_000))).catch((recoveryError: unknown) => {
          throw new NativeHostRecoveryError(execution.claim.claimId, leaseFailure, recoveryError);
        });
        return { disposition: "recovered", terminalEvent: terminal(execution, { kind: "lease-lost" }, captured, startedAt, finishedAt, identifiers()), stdout: captured.stdout, stderr: captured.stderr };
      }
      if (reportFailure instanceof NativeHostFinalizationUncertainError) throw reportFailure;
      await Promise.resolve(dependencies.recoverClaim(recoveryRequest(execution.claim, identifiers()), AbortSignal.timeout(30_000))).catch((recoveryError: unknown) => {
        throw new NativeHostRecoveryError(execution.claim.claimId, reportFailure, recoveryError);
      });
      return {
        disposition: "recovered",
        terminalEvent: terminal(execution, { kind: "executor-failure", code: "result-submission-failed" }, captured, startedAt, finishedAt, identifiers()),
        stdout: captured.stdout,
        stderr: captured.stderr
      };
    }
    return { disposition: "reported", terminalEvent, stdout: captured.stdout, stderr: captured.stderr };
  } catch (error) {
    if (error instanceof NativeHostRecoveryError || error instanceof NativeHostFinalizationUncertainError) throw error;
    await lease?.stop();
    const cleanupComplete = !containerCleanupArmed || await cleanupNativeContainer(dependencies.runner, execution.claim);
    containerCleanupArmed = false;
    if (!cleanupComplete) {
      throw new NativeHostCleanupError(execution.claim.claimId);
    }
    const finishedAt = now().toISOString();
    await Promise.resolve(dependencies.recoverClaim(recoveryRequest(execution.claim, identifiers()), AbortSignal.timeout(30_000))).catch((recoveryError: unknown) => {
      throw new NativeHostRecoveryError(execution.claim.claimId, error, recoveryError);
    });
    if (lease?.lost !== true) throw error;
    const terminalEvent = terminal(execution, { kind: "lease-lost" }, captured, startedAt, finishedAt, identifiers());
    return { disposition: "recovered", terminalEvent, stdout: captured.stdout, stderr: captured.stderr };
  } finally {
    await lease?.stop();
    if (containerCleanupArmed && !await cleanupNativeContainer(dependencies.runner, execution.claim)) {
      throw new NativeHostCleanupError(execution.claim.claimId);
    }
    await rm(root, { recursive: true, force: true });
  }
}

type CompletionInput = {
  readonly leaseLost: boolean;
  readonly externallyCancelled: boolean;
  readonly outputExceeded: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | undefined;
  readonly waitObserverExitCode: number;
  readonly logsObserverExitCode: number;
};

function classifyCompletion(input: CompletionInput): NativeTerminalCompletion {
  if (input.leaseLost) return { kind: "lease-lost" };
  if (input.externallyCancelled) return { kind: "cancelled" };
  if (input.outputExceeded) return { kind: "output-limit-exceeded" };
  if (input.timedOut) return { kind: "timed-out" };
  if (input.waitObserverExitCode !== 0 || input.logsObserverExitCode !== 0) {
    return { kind: "executor-failure", code: "container-observer-failed" };
  }
  if (input.exitCode === undefined) return { kind: "executor-failure", code: "invalid-container-exit" };
  return { kind: "exited", exitCode: input.exitCode };
}

function terminal(
  execution: NativeHostExecution,
  completion: NativeTerminalCompletion,
  output: ReturnType<NativeOutputCollector["result"]>,
  startedAt: string,
  finishedAt: string,
  eventId: string
): NativeTerminalEvent {
  const result = completion.kind === "cancelled" ? "cancelled"
    : completion.kind === "exited" && completion.exitCode === 0 ? "success" : "failure";
  return {
    schemaVersion: 2, eventId, occurredAt: finishedAt, eventType: "dim.ci.job.completed",
    payload: {
      reviewId: execution.claim.reviewId, attemptId: execution.claim.attemptId, attempt: execution.claim.attempt,
      descriptor: execution.claim.descriptor, descriptorDigest: execution.claim.descriptorDigest,
      hostId: execution.claim.hostId, capacity: execution.claim.capacity, startedAt, finishedAt,
      result, completion, stdout: output.stdoutEvidence, stderr: output.stderrEvidence
    }
  };
}

function recoveryRequest(claim: NativeHostClaim, requestId: string): NativeHostRecoveryRequest {
  return { ...renewalRequest(claim, requestId), resourceId: claim.claimId, cleanupComplete: true };
}

function parseExitCode(value: string): number | undefined {
  return /^(?:0|[1-9][0-9]{0,2})\n?$/.test(value) && Number(value.trim()) <= 255 ? Number(value.trim()) : undefined;
}

function toMilliseconds(seconds: string): number {
  const value = toNumber(seconds, "wall-clock") * 1_000;
  if (!Number.isSafeInteger(value)) throw new NativeHostVerificationError("wall-clock bound exceeds executor range");
  return value;
}

function toNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new NativeHostVerificationError(`${label} bound exceeds executor range`);
  return parsed;
}

export { NativeCandidateReadAuthority, NativeHostVerificationError };
export { NativeHostCleanupError, NativeHostFinalizationUncertainError, NativeHostLaunchError, NativeHostLeaseError, NativeHostRecoveryError } from "./nativeOrdinaryExecutorErrors.js";
