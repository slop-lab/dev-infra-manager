import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createNativeGitCandidateReadAuthorityFactory } from "./nativeGitCandidateReadAuthority.js";
import type { NativeOrdinaryHostClient } from "./nativeOrdinaryHostClient.js";
import {
  executeNativeHostClaim,
  NativeHostFinalizationUncertainError,
  type NativeCandidateReadAuthorityFactoryInput
} from "./nativeOrdinaryExecutor.js";
import { cleanupNativeContainer } from "./nativeOrdinaryExecutorDocker.js";
import { NativeHostCleanupError } from "./nativeOrdinaryExecutorErrors.js";
import {
  NativeOrdinaryHostJournal,
  type NativeHostJournalState
} from "./nativeOrdinaryHostJournal.js";
import { NativeOrdinaryHostRequestRejectedError } from "./nativeOrdinaryHostClient.js";
import type { NativeHostClaim, NativeHostRecoveryRequest } from "./nativeOrdinaryClaimProtocol.js";
import type { NativeHostResultRequest } from "./nativeOrdinaryResultProtocol.js";
import type { StreamingCommandRunner } from "./types.js";

export type NativeGitReaderCredentialScope = {
  readonly projectId: string;
  readonly repositoryId: string;
};

export type NativeGitProjectReaderCredential = NativeGitReaderCredentialScope & {
  readonly username: string;
  readonly password: string;
};

export type NativeGitProjectReaderCredentialResolver = (
  scope: NativeGitReaderCredentialScope
) => NativeGitProjectReaderCredential | undefined | Promise<NativeGitProjectReaderCredential | undefined>;

export type NativeOrdinaryHostCapacityDependencies = {
  readonly client: NativeOrdinaryHostClient;
  readonly runner: StreamingCommandRunner;
  readonly gitExecutable: string;
  readonly nativeGitEndpoint: string;
  readonly journalPath: string;
  readonly resolveReaderCredential: NativeGitProjectReaderCredentialResolver;
  readonly idleDelayMilliseconds?: number;
  readonly randomId?: () => string;
};

export async function serveNativeOrdinaryHostCapacity(
  dependencies: NativeOrdinaryHostCapacityDependencies,
  signal: AbortSignal
): Promise<void> {
  const randomId = dependencies.randomId ?? randomUUID;
  const journal = new NativeOrdinaryHostJournal(dependencies.journalPath);
  const idleDelayMilliseconds = dependencies.idleDelayMilliseconds ?? 1_000;
  if (!Number.isSafeInteger(idleDelayMilliseconds) || idleDelayMilliseconds < 1) {
    throw new NativeOrdinaryHostWorkerError("native ordinary idle delay is invalid");
  }
  try {
    await dependencies.client.attest(signal);
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  }
  const pending = await journal.load();
  if (pending !== undefined) await replayPending(dependencies, journal, pending, randomId, signal);
  while (!signal.aborted) {
    let claim: Awaited<ReturnType<NativeOrdinaryHostClient["claim"]>>;
    try {
      const request = dependencies.client.prepareClaim(randomId());
      await journal.save({ kind: "claim", request });
      claim = await dependencies.client.claim(request, signal);
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    if (claim === undefined) {
      await journal.clear();
      if (signal.aborted) return;
      try {
        await delay(idleDelayMilliseconds, undefined, { signal });
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      continue;
    }
    await journal.save({ kind: "active", claim });
    await executeClaim(dependencies, journal, claim, randomId, signal);
  }
}

async function executeClaim(
  dependencies: NativeOrdinaryHostCapacityDependencies,
  journal: NativeOrdinaryHostJournal,
  claim: NativeHostClaim,
  randomId: () => string,
  signal: AbortSignal
): Promise<void> {
  await executeNativeHostClaim({
      runner: dependencies.runner,
      createReadAuthority: (input) => createClaimReader(dependencies, input),
      renewClaim: (request, requestSignal) => dependencies.client.renewClaim(request, requestSignal),
      reportResult: (request, requestSignal) => reportResult(dependencies, journal, claim, request, requestSignal),
      recoverClaim: (request, requestSignal) => recoverClaim(dependencies, journal, claim, request, requestSignal),
      randomId
    }, { claim, signal });
}

async function reportResult(
  dependencies: NativeOrdinaryHostCapacityDependencies,
  journal: NativeOrdinaryHostJournal,
  claim: NativeHostClaim,
  request: NativeHostResultRequest,
  signal: AbortSignal
): Promise<void> {
  const prepared = dependencies.client.prepareResult(request);
  await journal.save({ kind: "result", claim, request: prepared });
  try {
    await dependencies.client.reportResult(prepared, signal);
  } catch (error) {
    if (isDefinitiveResultRejection(error)) throw error;
    throw new NativeHostFinalizationUncertainError("native ordinary result acknowledgement is uncertain", { cause: error });
  }
  await journal.clear();
}

async function recoverClaim(
  dependencies: NativeOrdinaryHostCapacityDependencies,
  journal: NativeOrdinaryHostJournal,
  claim: NativeHostClaim,
  request: NativeHostRecoveryRequest,
  signal: AbortSignal
): Promise<void> {
  const prepared = dependencies.client.prepareRecovery(request);
  await journal.save({ kind: "recovery", claim, request: prepared });
  await dependencies.client.recoverClaim(prepared, signal);
  await journal.clear();
}

async function replayPending(
  dependencies: NativeOrdinaryHostCapacityDependencies,
  journal: NativeOrdinaryHostJournal,
  state: NativeHostJournalState,
  randomId: () => string,
  signal: AbortSignal
): Promise<void> {
  switch (state.kind) {
    case "claim": {
      const claim = await dependencies.client.claim(state.request, signal);
      if (claim === undefined) {
        await journal.clear();
        return;
      }
      await journal.save({ kind: "active", claim });
      await executeClaim(dependencies, journal, claim, randomId, signal);
      return;
    }
    case "active":
      await cleanupForReplay(dependencies, state.claim);
      await recoverClaim(dependencies, journal, state.claim, recoveryRequest(state.claim, randomId()), signal);
      return;
    case "result":
      await cleanupForReplay(dependencies, state.claim);
      await replayResult(dependencies, journal, state, randomId, signal);
      return;
    case "recovery":
      await cleanupForReplay(dependencies, state.claim);
      await dependencies.client.recoverClaim(state.request, signal);
      await journal.clear();
      return;
    default:
      return assertNever(state);
  }
}

async function replayResult(
  dependencies: NativeOrdinaryHostCapacityDependencies,
  journal: NativeOrdinaryHostJournal,
  state: Extract<NativeHostJournalState, { readonly kind: "result" }>,
  randomId: () => string,
  signal: AbortSignal
): Promise<void> {
  try {
    await dependencies.client.reportResult(state.request, signal);
    await journal.clear();
  } catch (error) {
    if (!isDefinitiveResultRejection(error)) throw error;
    await recoverClaim(dependencies, journal, state.claim, recoveryRequest(state.claim, randomId()), signal);
  }
}

function isDefinitiveResultRejection(error: unknown): error is NativeOrdinaryHostRequestRejectedError {
  return error instanceof NativeOrdinaryHostRequestRejectedError
    && (error.statusCode === 404 || error.statusCode === 409);
}

async function cleanupForReplay(
  dependencies: NativeOrdinaryHostCapacityDependencies,
  claim: NativeHostClaim
): Promise<void> {
  if (!await cleanupNativeContainer(dependencies.runner, claim)) throw new NativeHostCleanupError(claim.claimId);
}

function recoveryRequest(claim: NativeHostClaim, requestId: string): NativeHostRecoveryRequest {
  return {
    schemaVersion: 1,
    requestId,
    hostId: claim.hostId,
    capacity: claim.capacity,
    claimId: claim.claimId,
    attemptId: claim.attemptId,
    descriptorDigest: claim.descriptorDigest,
    resourceId: claim.claimId,
    cleanupComplete: true
  };
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected native host journal state: ${JSON.stringify(value)}`);
}

async function createClaimReader(
  dependencies: NativeOrdinaryHostCapacityDependencies,
  input: NativeCandidateReadAuthorityFactoryInput
) {
  const scope = {
    projectId: input.claim.descriptor.projectId,
    repositoryId: input.claim.descriptor.repositoryId
  };
  const credential = await dependencies.resolveReaderCredential(scope);
  if (credential === undefined || credential.projectId !== scope.projectId
    || credential.repositoryId !== scope.repositoryId) {
    throw new NativeOrdinaryHostWorkerError("native Git reader credential mapping does not match the claim");
  }
  return createNativeGitCandidateReadAuthorityFactory({
    gitExecutable: dependencies.gitExecutable,
    serviceEndpoint: dependencies.nativeGitEndpoint,
    credential: {
      username: credential.username,
      password: credential.password
    }
  })(input);
}

export class NativeOrdinaryHostWorkerError extends Error {
  readonly name = "NativeOrdinaryHostWorkerError";
}
