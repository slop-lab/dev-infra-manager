import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { NativeOrdinaryHostClient } from "./nativeOrdinaryHostClient.js";
import {
  executeNativeHostClaim,
  NativeHostFinalizationUncertainError
} from "./nativeOrdinaryExecutor.js";
import { cleanupNativeContainer } from "./nativeOrdinaryExecutorDocker.js";
import { NativeHostCleanupError } from "./nativeOrdinaryExecutorErrors.js";
import {
  plannedNativeHostPrivateRoot,
  type NativeHostPrivateRootIdentity
} from "./nativeOrdinaryExecutorRoot.js";
import {
  NativeOrdinaryHostJournal,
  type NativeHostJournalState
} from "./nativeOrdinaryHostJournal.js";
import { NativeOrdinaryHostRequestRejectedError } from "./nativeOrdinaryHostClient.js";
import type { NativeHostClaim, NativeHostRecoveryRequest } from "./nativeOrdinaryClaimProtocol.js";
import type { NativeHostResultRequest } from "./nativeOrdinaryResultProtocol.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";
import {
  createNativeHostClaimReader,
  NativeOrdinaryHostWorkerError,
  type NativeGitProjectReaderCredentialResolver
} from "./nativeOrdinaryHostWorkerReader.js";

export { NativeOrdinaryHostWorkerError } from "./nativeOrdinaryHostWorkerReader.js";

export type {
  NativeGitProjectReaderCredential,
  NativeGitProjectReaderCredentialResolver,
  NativeGitReaderCredentialScope
} from "./nativeOrdinaryHostWorkerReader.js";

export type NativeOrdinaryHostCapacityDependencies = {
  readonly client: NativeOrdinaryHostClient;
  readonly runner: StreamingCommandRunner;
  readonly gitExecutable: string;
  readonly nativeGitEndpoint: string;
  readonly journalPath: string;
  readonly resolveReaderCredential?: NativeGitProjectReaderCredentialResolver;
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
    await startClaim(dependencies, journal, claim, randomId, signal);
  }
}

async function startClaim(
  dependencies: NativeOrdinaryHostCapacityDependencies,
  journal: NativeOrdinaryHostJournal,
  claim: NativeHostClaim,
  randomId: () => string,
  signal: AbortSignal
): Promise<void> {
  const privateRoot = plannedNativeHostPrivateRoot(randomId());
  await journal.save({ kind: "active", claim, privateRoot });
  await executeClaim(dependencies, journal, claim, privateRoot, randomId, signal);
}

async function executeClaim(
  dependencies: NativeOrdinaryHostCapacityDependencies,
  journal: NativeOrdinaryHostJournal,
  claim: NativeHostClaim,
  privateRootIdentity: NativeHostPrivateRootIdentity,
  randomId: () => string,
  signal: AbortSignal
): Promise<void> {
  const privateRoot = journal.privateRoot(privateRootIdentity);
  await executeNativeHostClaim({
      runner: dependencies.runner,
      createReadAuthority: async (input) => {
        if (dependencies.resolveReaderCredential !== undefined) return createNativeHostClaimReader({ ...dependencies,
          resolveReaderCredential: dependencies.resolveReaderCredential }, input);
        const lease = await dependencies.client.candidateLease(input.claim, randomId(), input.signal);
        return createNativeHostClaimReader({ ...dependencies,
          resolveReaderCredential: () => ({ projectId: input.claim.descriptor.projectId,
            repositoryId: input.claim.descriptor.repositoryId, username: lease.username, password: lease.password }) }, input);
      },
      renewClaim: (request, requestSignal) => dependencies.client.renewClaim(request, requestSignal),
      reportResult: (request, requestSignal) => reportResult(dependencies, journal, claim, privateRoot.identity, request, requestSignal),
      recoverClaim: (request, requestSignal) => recoverClaim(dependencies, journal, claim, privateRoot.identity, request, requestSignal),
      randomId
    }, {
      claim,
      signal,
      managedPrivateRoot: {
        root: privateRoot,
        publishCreated: (identity) => journal.save({ kind: "active", claim, privateRoot: identity })
      }
    });
}

async function reportResult(
  dependencies: NativeOrdinaryHostCapacityDependencies,
  journal: NativeOrdinaryHostJournal,
  claim: NativeHostClaim,
  privateRoot: NativeHostPrivateRootIdentity,
  request: NativeHostResultRequest,
  signal: AbortSignal
): Promise<void> {
  const prepared = dependencies.client.prepareResult(request);
  await journal.save({ kind: "result", claim, privateRoot, request: prepared });
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
  privateRoot: NativeHostPrivateRootIdentity,
  request: NativeHostRecoveryRequest,
  signal: AbortSignal
): Promise<void> {
  const prepared = dependencies.client.prepareRecovery(request);
  await journal.save({ kind: "recovery", claim, privateRoot, request: prepared });
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
      await startClaim(dependencies, journal, claim, randomId, signal);
      return;
    }
    case "active":
      await cleanupForReplay(dependencies, journal, state.claim, state.privateRoot);
      await recoverClaim(dependencies, journal, state.claim, state.privateRoot,
        recoveryRequest(state.claim, randomId()), signal);
      return;
    case "result":
      await cleanupForReplay(dependencies, journal, state.claim, state.privateRoot);
      await replayResult(dependencies, journal, state, randomId, signal);
      return;
    case "recovery":
      await cleanupForReplay(dependencies, journal, state.claim, state.privateRoot);
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
    await recoverClaim(dependencies, journal, state.claim, state.privateRoot,
      recoveryRequest(state.claim, randomId()), signal);
  }
}

function isDefinitiveResultRejection(error: unknown): error is NativeOrdinaryHostRequestRejectedError {
  return error instanceof NativeOrdinaryHostRequestRejectedError
    && (error.statusCode === 404 || error.statusCode === 409);
}

async function cleanupForReplay(
  dependencies: NativeOrdinaryHostCapacityDependencies,
  journal: NativeOrdinaryHostJournal,
  claim: NativeHostClaim,
  privateRoot: NativeHostPrivateRootIdentity
): Promise<void> {
  const containerCleaned = await cleanupNativeContainer(dependencies.runner, claim);
  const rootCleaned = await journal.privateRoot(privateRoot).cleanup(claim.claimId);
  if (!containerCleaned || !rootCleaned) throw new NativeHostCleanupError(claim.claimId);
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
