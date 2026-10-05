import { DatabaseSync } from "node:sqlite";
import {
  NativeGitAttemptIssuerUnavailableError,
  type NativeGitAttemptIssuerClient,
  type NativeAttemptIssueRequest
} from "../../../../core/packages/core/src/nativeGitAttemptIssuerClient.js";
import type { NativeJobAttemptIssuance } from "../../../../core/packages/core/src/nativeGitAttemptIssuerModel.js";
import { nativeDescriptorDigest } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityModel.js";
import {
  admission,
  assignment,
  descriptor,
  jsonRecord,
  nativeEvent,
  post,
  startAuthority,
  type AuthorityFixture,
  type StartAuthorityOptions
} from "./nativeOrdinaryAuthorityFixture.js";

export type LeaseIssuer = NativeGitAttemptIssuerClient & {
  readonly revocations: () => number;
  readonly revocationObservedUnlocked: () => boolean;
  readonly failNextRevocation: () => void;
  readonly authorizeWith: (fixture: AuthorityFixture) => void;
};

export function leaseIssuer(): LeaseIssuer {
  let fixture: AuthorityFixture | undefined;
  let revocations = 0;
  let failRevocation = false;
  let attempts = 0;
  let observedUnlocked = false;
  return {
    authorizeWith(value) {
      fixture = value;
    },
    revocations: () => revocations,
    revocationObservedUnlocked: () => observedUnlocked,
    failNextRevocation() {
      failRevocation = true;
    },
    async loadDescriptor(context) {
      const value = {
        ...descriptor(context.event.projectId, context.event.repositoryId, context.admissionGeneration),
        policyRevision: context.event.policyRevision,
        requiredReviewRevision: context.event.requiredReviewRevision,
        requiredJobSetRevision: context.event.requiredJobSetRevision
      };
      return { reviewId: context.event.reviewId, descriptor: value, digest: nativeDescriptorDigest(value) };
    },
    async issueAttempt(input) {
      attempts += 1;
      const issuance = issuanceFor(input, attempts);
      fixture?.source.authorizeAttempt(assignment(issuance.descriptor, issuance.reviewId, issuance.attemptId));
      return { replayed: false, issuance };
    },
    async revokeAttempt(issuance) {
      if (fixture === undefined) throw new TypeError("authority fixture is unavailable");
      const database = new DatabaseSync(fixture.database);
      database.exec("BEGIN IMMEDIATE; ROLLBACK;");
      database.close();
      observedUnlocked = true;
      revocations += 1;
      if (failRevocation) {
        failRevocation = false;
        throw new NativeGitAttemptIssuerUnavailableError();
      }
      return {
        schemaVersion: 2,
        revocationId: "40000000-0000-4000-8000-000000000019",
        attemptId: issuance.attemptId,
        reviewId: issuance.reviewId,
        jobName: issuance.descriptor.jobName,
        attempt: issuance.attempt,
        descriptorDigest: issuance.descriptorDigest,
        hostId: issuance.hostId,
        capacity: issuance.capacity,
        revokedBy: "ordinary-attempts",
        revokedAt: "2026-10-05T00:00:01.000Z"
      };
    }
  };
}

export async function preparedLeaseFixture(
  issuer: LeaseIssuer,
  options: Omit<StartAuthorityOptions, "attemptIssuerClient"> = {}
): Promise<{ readonly fixture: AuthorityFixture; readonly claim: Readonly<Record<string, unknown>> }> {
  const fixture = await startAuthority({ ...options, attemptIssuerClient: issuer });
  issuer.authorizeWith(fixture);
  const policy = admission("project-a", "source", "1");
  fixture.source.authorizePolicy(policy);
  await post(fixture.endpoint, "/v1/operator-admissions", "registrar", policy);
  const event = nativeEvent();
  fixture.source.authorizeEvent(event);
  await post(fixture.endpoint, "/v1/native-events", "webhook", event);
  const response = await post(fixture.endpoint, "/v1/host-claims", "host-a", claimRequest());
  return { fixture, claim: await jsonRecord(response) };
}

export function claimRequest(requestId = "20000000-0000-4000-8000-000000000031") {
  return { schemaVersion: 1, requestId, hostId: "host-a", capacity: "primary" } as const;
}

export function renewalRequest(claim: Readonly<Record<string, unknown>>, requestId: string) {
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

export function recoveryRequest(claim: Readonly<Record<string, unknown>>, requestId: string) {
  return {
    ...renewalRequest(claim, requestId),
    resourceId: claim.claimId,
    cleanupComplete: true
  };
}

function issuanceFor(input: NativeAttemptIssueRequest, attempt: number): NativeJobAttemptIssuance {
  return {
    schemaVersion: 2,
    issuanceRequestId: input.issuanceRequestId,
    attemptId: `10000000-0000-4000-8000-${attempt.toString().padStart(12, "0")}`,
    reviewId: input.context.event.reviewId,
    attempt,
    descriptor: input.descriptor.descriptor,
    descriptorDigest: input.descriptor.digest,
    hostId: input.context.capacity.hostId,
    capacity: input.context.capacity.capacity,
    issuedBy: "ordinary-attempts",
    issuedAt: "2026-10-05T00:00:00.000Z"
  };
}
