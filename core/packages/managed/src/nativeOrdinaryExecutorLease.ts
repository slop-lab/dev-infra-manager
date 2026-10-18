import { setTimeout as delay } from "node:timers/promises";
import type {
  NativeHostClaim,
  NativeHostClaimRenewal,
  NativeHostClaimRenewalRequest
} from "./nativeOrdinaryClaimProtocol.js";
import { NativeHostLeaseError } from "./nativeOrdinaryExecutorErrors.js";

type NativeLeaseStart = {
  readonly claim: NativeHostClaim;
  readonly renewClaim: (request: NativeHostClaimRenewalRequest, signal: AbortSignal) => Promise<NativeHostClaimRenewal>;
  readonly randomId: () => string;
  readonly signal: AbortSignal;
};

type NativeLeaseMaintenance = NativeLeaseStart & {
  readonly initial: NativeHostClaimRenewal;
  readonly initialRequestStarted: number;
  readonly leaseSignal: AbortSignal;
  readonly stopSignal: AbortSignal;
  readonly accept: (response: NativeHostClaimRenewal, requestStarted: number) => boolean;
};

export type NativeLease = {
  readonly signal: AbortSignal;
  readonly lost: boolean;
  readonly failure: unknown;
  readonly isCurrent: () => boolean;
  readonly stop: () => Promise<void>;
};

export async function startNativeLease(input: NativeLeaseStart): Promise<NativeLease> {
  const requestStarted = performance.now();
  const initial = await input.renewClaim(renewalRequest(input.claim, input.randomId()), input.signal);
  const initialDeadline = requestStarted + initial.leaseDurationMilliseconds;
  if (performance.now() >= initialDeadline) throw new NativeHostLeaseError(input.claim.claimId);

  const leaseController = new AbortController();
  const stopController = new AbortController();
  let deadline = initialDeadline;
  let deadlineController = new AbortController();
  let deadlineTask: Promise<void>;
  let lost = false;
  let failure: unknown = new NativeHostLeaseError(input.claim.claimId);

  const lose = (error: unknown): void => {
    if (lost) {
      if (failure instanceof NativeHostLeaseError && error !== leaseController.signal.reason) failure = error;
      return;
    }
    if (stopController.signal.aborted) return;
    lost = true;
    failure = error;
    leaseController.abort(error);
  };
  const armDeadline = (nextDeadline: number): void => {
    deadlineController.abort();
    deadlineController = new AbortController();
    deadline = nextDeadline;
    const timerSignal = AbortSignal.any([stopController.signal, deadlineController.signal]);
    deadlineTask = delay(Math.max(0, deadline - performance.now()), undefined, { signal: timerSignal })
      .then(() => lose(new NativeHostLeaseError(input.claim.claimId)))
      .catch((error: unknown) => {
        if (!timerSignal.aborted) lose(error);
      });
  };
  armDeadline(initialDeadline);

  const renewal = maintainLease({
    ...input,
    initial,
    initialRequestStarted: requestStarted,
    leaseSignal: leaseController.signal,
    stopSignal: stopController.signal,
    accept(response, started) {
      const nextDeadline = started + response.leaseDurationMilliseconds;
      if (performance.now() >= nextDeadline) {
        lose(new NativeHostLeaseError(input.claim.claimId));
        return false;
      }
      armDeadline(nextDeadline);
      return true;
    }
  }).catch((error: unknown) => {
    if (!stopController.signal.aborted) lose(error);
  });

  return {
    signal: leaseController.signal,
    get lost() { return lost; },
    get failure() { return failure; },
    isCurrent() {
      if (!lost && performance.now() >= deadline) lose(new NativeHostLeaseError(input.claim.claimId));
      return !lost;
    },
    async stop() {
      stopController.abort();
      deadlineController.abort();
      await renewal;
      await deadlineTask;
    }
  };
}

async function maintainLease(input: NativeLeaseMaintenance): Promise<void> {
  let response = input.initial;
  let requestStarted = input.initialRequestStarted;
  while (!input.stopSignal.aborted && !input.leaseSignal.aborted) {
    const renewalAt = requestStarted + Math.max(1, Math.floor(response.leaseDurationMilliseconds / 2));
    await delay(Math.max(0, renewalAt - performance.now()), undefined, {
      signal: AbortSignal.any([input.stopSignal, input.leaseSignal])
    });
    requestStarted = performance.now();
    response = await input.renewClaim(
      renewalRequest(input.claim, input.randomId()),
      AbortSignal.any([input.stopSignal, input.leaseSignal])
    );
    if (!input.accept(response, requestStarted)) return;
  }
}

export function renewalRequest(claim: NativeHostClaim, requestId: string): NativeHostClaimRenewalRequest {
  return {
    schemaVersion: 1,
    requestId,
    hostId: claim.hostId,
    capacity: claim.capacity,
    claimId: claim.claimId,
    attemptId: claim.attemptId,
    descriptorDigest: claim.descriptorDigest
  };
}
