import { createHash } from "node:crypto";
import type { NativeOrdinaryDescriptor } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityProtocol.js";
import type { NativeRootCiReviewEvent } from "../../../../core/packages/core/src/nativeRootCiReviewEvent.js";

const admissionGeneration = "00000000-0000-4000-8000-000000000104";
const claimId = "00000000-0000-4000-8000-000000000101";

export function schema2Event(
  descriptor: NativeOrdinaryDescriptor,
  reviewId: string
): NativeRootCiReviewEvent {
  return {
    schemaVersion: 3,
    type: "dim.native.review-job.available",
    eventId: createHash("sha256").update("dim-native-authoritative-review-event-v3\0")
      .update(JSON.stringify({ envelopeId: "9".repeat(64), executionKind: "ordinary-sysbox",
        jobName: descriptor.jobName })).digest("hex"),
    projectId: descriptor.projectId,
    repositoryId: "root",
    protectedRef: descriptor.protectedRef,
    reviewId,
    envelopeId: "9".repeat(64),
    expectedProtectedHead: descriptor.expectedProtectedHead,
    candidateCommit: descriptor.candidateCommit,
    candidateTree: descriptor.candidateTree,
    policyRevision: descriptor.policyRevision,
    requiredReviewRevision: descriptor.requiredReviewRevision,
    qualityRevision: descriptor.requiredJobSetRevision,
    executionKind: "ordinary-sysbox",
    jobName: descriptor.jobName,
    evidenceClass: "candidate-controlled"
  };
}

export function reservationContext(
  event: NativeRootCiReviewEvent,
  capacity: {
    readonly hostId: string;
    readonly capacity: string;
    readonly runnerBaseImage: string;
    readonly jobBaseImage: string;
    readonly bounds: NativeOrdinaryDescriptor["bounds"];
  },
  servingGenerationId = "a".repeat(64)
) {
  return {
    claim: {
      schemaVersion: 1,
      serviceId: "ordinary-main",
      generationId: servingGenerationId,
      serviceEpochId: "00000000-0000-4000-8000-000000000102",
      requestId: "00000000-0000-4000-8000-000000000103",
      claimId,
      issuanceRequestId: claimId,
      demandId: "00000000-0000-4000-8000-000000000105",
      admissionGeneration,
      eventDigest: `sha256:${"1".repeat(64)}`,
      event,
      admission: {
        projectId: event.projectId,
        repositoryId: "root",
        importNonce: "00000000-0000-4000-8000-000000000106",
        rootSequence: 0,
        protectedRef: event.protectedRef,
        rootCommit: event.expectedProtectedHead,
        rootTree: event.candidateTree,
        policyDigest: "2".repeat(64),
        capacityConfigDigest: "3".repeat(64),
        leaseExpiresAt: 1_800_000_000_000
      },
      hostId: capacity.hostId,
      capacity: capacity.capacity,
      runnerBaseImage: capacity.runnerBaseImage,
      jobBaseImage: capacity.jobBaseImage,
      bounds: capacity.bounds
    }
  } as const;
}
