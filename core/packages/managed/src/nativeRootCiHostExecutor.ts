import type { NativeHostClaim, NativeHostRecoveryRequest } from "./nativeOrdinaryClaimProtocol.js";
import { cleanupNativeContainer } from "./nativeOrdinaryExecutorDocker.js";
import { NativeHostCleanupError } from "./nativeOrdinaryExecutorErrors.js";
import {
  executeNativeHostClaim,
  type NativeHostExecutionResult
} from "./nativeOrdinaryExecutor.js";
import { createNativeGitCandidateReadAuthorityFactory } from "./nativeGitCandidateReadAuthority.js";
import type { NativeRootCiActiveClaim } from "./nativeRootCiClaimLifecycleProtocol.js";
import type { NativeRootCiClaim } from "./nativeRootCiClaimProtocol.js";
import type { NativeRootCiHostResultRequest, NativeRootCiTerminalEvent } from "./nativeRootCiResultProtocol.js";
import type { NativeRootCiHostClient } from "./nativeRootCiHostClient.js";
import type { NativeRootCiHostJournal } from "./nativeRootCiHostJournal.js";
import type { NativeHostPrivateRootIdentity } from "./nativeOrdinaryExecutorRoot.js";
import type { NativeHostResultRequest } from "./nativeOrdinaryResultProtocol.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";
import { verifyAndMaterializeNativeRootCiCandidate } from "./nativeRootCiHostCandidateVerifier.js";

export type NativeRootCiHostExecutionDependencies = {
  readonly client: NativeRootCiHostClient;
  readonly runner: StreamingCommandRunner;
  readonly gitExecutable: string;
  readonly nativeGitEndpoint: string;
  readonly journal: NativeRootCiHostJournal;
  readonly randomId: () => string;
};

export async function executeNativeRootCiHostClaim(
  dependencies: NativeRootCiHostExecutionDependencies,
  claim: NativeRootCiClaim,
  active: NativeRootCiActiveClaim,
  privateRootIdentity: NativeHostPrivateRootIdentity,
  signal: AbortSignal
): Promise<NativeHostExecutionResult> {
  const legacyClaim = nativeRootCiHostExecutorClaim(claim, active);
  const privateRoot = dependencies.journal.privateRoot(privateRootIdentity);
  return executeNativeHostClaim({
    runner: dependencies.runner,
    createReadAuthority: async (input) => {
      const lease = await dependencies.client.candidateLease(active, dependencies.randomId(), input.signal);
      return createNativeGitCandidateReadAuthorityFactory({
        gitExecutable: dependencies.gitExecutable,
        serviceEndpoint: dependencies.nativeGitEndpoint,
        credential: { username: lease.username, password: lease.password }
      })(input);
    },
    renewClaim: async (request, requestSignal) => {
      const renewed = await dependencies.client.renew(
        dependencies.client.prepareRenewal(active, request.requestId), requestSignal);
      return { schemaVersion: 1, serviceId: renewed.serviceId, requestId: renewed.requestId,
        claimId: renewed.claimId, leaseExpiresAt: renewed.leaseExpiresAt,
        leaseDurationMilliseconds: renewed.leaseDurationMilliseconds };
    },
    reportResult: (request, requestSignal) => report(dependencies, claim, active,
      privateRoot.identity, request, requestSignal),
    recoverClaim: (request, requestSignal) => recover(dependencies, claim, active,
      privateRoot.identity, request, requestSignal),
    randomId: dependencies.randomId,
    verifyCandidate: verifyAndMaterializeNativeRootCiCandidate
  }, { claim: legacyClaim, signal, managedPrivateRoot: { root: privateRoot,
    publishCreated: (identity) => dependencies.journal.save({ kind: "active", claim, active, privateRoot: identity }) } });
}

export function nativeRootCiHostExecutorClaim(
  claim: NativeRootCiClaim,
  active: NativeRootCiActiveClaim
): NativeHostClaim {
  const issuance = active.issuance;
  return { schemaVersion: 1, serviceId: claim.serviceId, requestId: claim.requestId, claimId: claim.claimId,
    eventId: claim.event.eventId, reviewId: issuance.reviewId, attemptId: issuance.attemptId,
    attempt: issuance.attempt, admissionGeneration: claim.admissionGeneration, hostId: claim.hostId,
    capacity: claim.capacity, leaseExpiresAt: active.leaseExpiresAt, descriptor: issuance.descriptor,
    descriptorDigest: issuance.descriptorDigest };
}

export async function cleanupNativeRootCiHostResources(
  runner: StreamingCommandRunner,
  journal: NativeRootCiHostJournal,
  claim: NativeRootCiClaim,
  active: NativeRootCiActiveClaim,
  privateRoot: NativeHostPrivateRootIdentity
): Promise<void> {
  const containerCleaned = await cleanupNativeContainer(runner, nativeRootCiHostExecutorClaim(claim, active));
  const rootCleaned = await journal.privateRoot(privateRoot).cleanup(claim.claimId);
  if (!containerCleaned || !rootCleaned) throw new NativeHostCleanupError(claim.claimId);
}

async function report(
  dependencies: NativeRootCiHostExecutionDependencies,
  claim: NativeRootCiClaim,
  active: NativeRootCiActiveClaim,
  privateRoot: NativeHostPrivateRootIdentity,
  request: NativeHostResultRequest,
  signal: AbortSignal
): Promise<void> {
  const terminalEvent: NativeRootCiTerminalEvent = { ...request.terminalEvent, schemaVersion: 3,
    payload: { executionKind: "ordinary-sysbox", ...request.terminalEvent.payload } };
  const rootRequest: NativeRootCiHostResultRequest = { schemaVersion: 2, requestId: request.requestId,
    generationId: claim.generationId, claimId: claim.claimId, resourceId: claim.claimId,
    terminalEvent, cleanupComplete: true };
  const prepared = dependencies.client.prepareResult(rootRequest);
  await dependencies.journal.save({ kind: "result", claim, active, privateRoot, request: prepared });
  await dependencies.client.report(prepared, signal);
  await dependencies.journal.clear();
}

async function recover(
  dependencies: NativeRootCiHostExecutionDependencies,
  claim: NativeRootCiClaim,
  active: NativeRootCiActiveClaim,
  privateRoot: NativeHostPrivateRootIdentity,
  request: NativeHostRecoveryRequest,
  signal: AbortSignal
): Promise<void> {
  const prepared = dependencies.client.prepareRecovery(claim, active.issuance, request.requestId);
  await dependencies.journal.save({ kind: "recovery", claim, active, privateRoot, request: prepared });
  await dependencies.client.recover(prepared, signal);
  await dependencies.journal.clear();
}
