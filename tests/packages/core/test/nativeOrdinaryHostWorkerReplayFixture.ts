import type { NativeOrdinaryHostClient } from "../../../../core/packages/core/src/nativeOrdinaryHostClient.js";
import { execution } from "./nativeOrdinaryExecutorFixture.js";

export class WorkerClient implements NativeOrdinaryHostClient {
  readonly hostId = "host-a";
  readonly capacity = "primary";
  readonly claimRequests: string[] = [];
  readonly resultRequests: unknown[] = [];
  readonly #claim: ReturnType<typeof execution>["claim"] | undefined;

  constructor(claim: ReturnType<typeof execution>["claim"] | null = execution().claim) {
    this.#claim = claim ?? undefined;
  }

  async attest(): Promise<void> {}
  prepareClaim(requestId: string) {
    return { requestId, body: JSON.stringify({ schemaVersion: 1, requestId, hostId: this.hostId, capacity: this.capacity }) };
  }
  async claim(request: ReturnType<WorkerClient["prepareClaim"]>) {
    this.claimRequests.push(request.requestId);
    return this.#claim === undefined ? undefined : { ...this.#claim, requestId: request.requestId };
  }
  async renewClaim(request: Parameters<NativeOrdinaryHostClient["renewClaim"]>[0]) {
    return {
      schemaVersion: 1, serviceId: "ordinary-main", requestId: request.requestId, claimId: request.claimId,
      leaseExpiresAt: Date.now() + 60_000, leaseDurationMilliseconds: 60_000
    } as const;
  }
  prepareRecovery(request: Parameters<NativeOrdinaryHostClient["prepareRecovery"]>[0]) {
    return { requestId: request.requestId, body: JSON.stringify(request) };
  }
  async recoverClaim(_request: Parameters<NativeOrdinaryHostClient["recoverClaim"]>[0]): Promise<void> {}
  prepareResult(request: Parameters<NativeOrdinaryHostClient["prepareResult"]>[0]) {
    return { requestId: request.requestId, body: JSON.stringify(request) };
  }
  async reportResult(request: Parameters<NativeOrdinaryHostClient["reportResult"]>[0]): Promise<void> {
    this.resultRequests.push(request);
  }
}

export function resultRequest(
  claim: ReturnType<typeof execution>["claim"]
): Parameters<NativeOrdinaryHostClient["prepareResult"]>[0] {
  const now = "2026-10-05T00:00:00.000Z";
  return {
    schemaVersion: 1,
    requestId: "50000000-0000-4000-8000-000000000001",
    claimId: claim.claimId,
    terminalEvent: {
      schemaVersion: 2,
      eventId: "60000000-0000-4000-8000-000000000001",
      occurredAt: now,
      eventType: "dim.ci.job.completed",
      payload: {
        reviewId: claim.reviewId, attemptId: claim.attemptId, attempt: claim.attempt,
        descriptor: claim.descriptor, descriptorDigest: claim.descriptorDigest,
        hostId: claim.hostId, capacity: claim.capacity, startedAt: now, finishedAt: now,
        result: "success", completion: { kind: "exited", exitCode: 0 },
        stdout: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false },
        stderr: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false }
      }
    },
    cleanupComplete: true
  };
}

export function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `90000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}
