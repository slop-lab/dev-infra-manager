import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { tryAcquireKernelGuard, type KernelGuard } from "./lifecycleLockGuard.js";
import type { NativeRootCiActiveClaim } from "./nativeRootCiClaimLifecycleProtocol.js";
import type { NativeRootCiClaim } from "./nativeRootCiClaimProtocol.js";
import type { NativeRootCiHostClient } from "./nativeRootCiHostClient.js";
import {
  cleanupNativeRootCiHostResources,
  executeNativeRootCiHostClaim
} from "./nativeRootCiHostExecutor.js";
import {
  NativeRootCiHostJournal,
  type NativeRootCiHostJournalState
} from "./nativeRootCiHostJournal.js";
import { NativeRootCiHostRejectedError } from "./nativeRootCiHostClient.js";
import { plannedNativeHostPrivateRoot,
  type NativeHostPrivateRootIdentity } from "./nativeOrdinaryExecutorRoot.js";
import type { StreamingCommandRunner } from "./types.js";

export type NativeRootCiHostCapacityDependencies = {
  readonly client: NativeRootCiHostClient;
  readonly runner: StreamingCommandRunner;
  readonly gitExecutable: string;
  readonly nativeGitEndpoint: string;
  readonly journalPath: string;
  readonly idleDelayMilliseconds?: number;
  readonly randomId?: () => string;
  readonly capacityGuard?: KernelGuard;
};

export async function acquireNativeRootCiHostCapacityGuard(journalPath: string): Promise<KernelGuard> {
  const journal = new NativeRootCiHostJournal(journalPath);
  await journal.prepare();
  const guard = await tryAcquireKernelGuard(`${journalPath}.guard`);
  if (guard === undefined) throw new NativeRootCiHostWorkerError("native root CI capacity is already served by another process");
  return guard;
}

export async function serveNativeRootCiHostCapacity(
  dependencies: NativeRootCiHostCapacityDependencies,
  signal: AbortSignal
): Promise<void> {
  const randomId = dependencies.randomId ?? randomUUID;
  const journal = new NativeRootCiHostJournal(dependencies.journalPath);
  const idleDelay = dependencies.idleDelayMilliseconds ?? 1_000;
  if (!Number.isSafeInteger(idleDelay) || idleDelay < 1) {
    throw new NativeRootCiHostWorkerError("native root CI host idle delay is invalid");
  }
  const guard = dependencies.capacityGuard ?? await acquireNativeRootCiHostCapacityGuard(dependencies.journalPath);
  try {
    try { await dependencies.client.attest(signal); }
    catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    const pending = await journal.load();
    if (pending !== undefined) await replay(dependencies, journal, pending, randomId, signal);
    while (!signal.aborted) {
      const request = dependencies.client.prepareClaim(randomId());
      await journal.save({ kind: "claim", request });
      let claim: NativeRootCiClaim | undefined;
      try { claim = await dependencies.client.reserve(request, signal); }
      catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (claim === undefined) {
        await journal.clear();
        if (signal.aborted) return;
        try { await delay(idleDelay, undefined, { signal }); }
        catch (error) {
          if (signal.aborted) return;
          throw error;
        }
        continue;
      }
      await journal.save({ kind: "reserved", claim });
      await issueActivateExecute(dependencies, journal, claim, randomId, signal);
    }
  } finally {
    await guard.release();
  }
}

async function issueActivateExecute(
  dependencies: NativeRootCiHostCapacityDependencies,
  journal: NativeRootCiHostJournal,
  claim: NativeRootCiClaim,
  randomId: () => string,
  signal: AbortSignal
): Promise<void> {
  const issuance = await dependencies.client.issue(claim, signal);
  const request = dependencies.client.prepareActivation(claim, issuance, randomId());
  await journal.save({ kind: "activation", claim, issuance, request });
  const active = await dependencies.client.activate(request, finalizationSignal(signal));
  await executeActive(dependencies, journal, claim, active, plannedNativeHostPrivateRoot(randomId()), randomId, signal);
}

async function executeActive(
  dependencies: NativeRootCiHostCapacityDependencies,
  journal: NativeRootCiHostJournal,
  claim: NativeRootCiClaim,
  active: NativeRootCiActiveClaim,
  privateRoot: NativeHostPrivateRootIdentity,
  randomId: () => string,
  signal: AbortSignal
): Promise<void> {
  await journal.save({ kind: "active", claim, active, privateRoot });
  await executeNativeRootCiHostClaim({ client: dependencies.client, runner: dependencies.runner,
    gitExecutable: dependencies.gitExecutable, nativeGitEndpoint: dependencies.nativeGitEndpoint,
    journal, randomId }, claim, active, privateRoot, signal);
}

async function replay(
  dependencies: NativeRootCiHostCapacityDependencies,
  journal: NativeRootCiHostJournal,
  state: NativeRootCiHostJournalState,
  randomId: () => string,
  signal: AbortSignal
): Promise<void> {
  switch (state.kind) {
    case "claim": {
      const claim = await dependencies.client.reserve(state.request, finalizationSignal(signal));
      if (claim === undefined) return journal.clear();
      await journal.save({ kind: "reserved", claim });
      return issueActivateExecute(dependencies, journal, claim, randomId, signal);
    }
    case "reserved":
      return issueActivateExecute(dependencies, journal, state.claim, randomId, signal);
    case "activation": {
      const active = await dependencies.client.activate(state.request, finalizationSignal(signal));
      return executeActive(dependencies, journal, state.claim, active,
        plannedNativeHostPrivateRoot(randomId()), randomId, signal);
    }
    case "active":
      await cleanup(dependencies, journal, state);
      return recover(dependencies, journal, state.claim, state.active, state.privateRoot, randomId(), signal);
    case "result":
      await cleanup(dependencies, journal, state);
      try {
        await dependencies.client.report(state.request, finalizationSignal(signal));
        return journal.clear();
      } catch (error) {
        if (!definitive(error)) throw error;
        return recover(dependencies, journal, state.claim, state.active, state.privateRoot, randomId(), signal);
      }
    case "recovery":
      await cleanup(dependencies, journal, state);
      await dependencies.client.recover(state.request, finalizationSignal(signal));
      return journal.clear();
    default:
      return assertNever(state);
  }
}

async function cleanup(
  dependencies: NativeRootCiHostCapacityDependencies,
  journal: NativeRootCiHostJournal,
  state: Extract<NativeRootCiHostJournalState, { readonly kind: "active" | "result" | "recovery" }>
): Promise<void> {
  await cleanupNativeRootCiHostResources(dependencies.runner, journal,
    state.claim, state.active, state.privateRoot);
}

async function recover(
  dependencies: NativeRootCiHostCapacityDependencies,
  journal: NativeRootCiHostJournal,
  claim: NativeRootCiClaim,
  active: NativeRootCiActiveClaim,
  privateRoot: NativeHostPrivateRootIdentity,
  requestId: string,
  signal: AbortSignal
): Promise<void> {
  const request = dependencies.client.prepareRecovery(claim, active.issuance, requestId);
  await journal.save({ kind: "recovery", claim, active, privateRoot, request });
  await dependencies.client.recover(request, finalizationSignal(signal));
  await journal.clear();
}

function finalizationSignal(signal: AbortSignal): AbortSignal {
  return signal.aborted ? AbortSignal.timeout(30_000) : AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
}

function definitive(error: unknown): boolean {
  return error instanceof NativeRootCiHostRejectedError
    && (error.statusCode === 404 || error.statusCode === 409);
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected native root CI host journal state: ${JSON.stringify(value)}`);
}

export class NativeRootCiHostWorkerError extends Error {
  readonly name = "NativeRootCiHostWorkerError";
}
