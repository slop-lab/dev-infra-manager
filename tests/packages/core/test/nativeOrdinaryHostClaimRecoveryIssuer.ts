import type { LegacyNativeAttemptIssuer } from "../../../../core/packages/managed/src/nativeOrdinaryClaimService.js";
import { nativeDescriptorDigest } from "../../../../core/packages/managed/src/nativeOrdinaryAuthorityModel.js";
import { assignment, descriptor } from "./nativeOrdinaryAuthorityFixture.js";

type IssuerHooks = {
  readonly issued: (input: { readonly issuanceRequestId: string }, authorize: () => void) => void | Promise<void>;
  readonly revoked?: () => void;
};

export type ControllableIssuer = LegacyNativeAttemptIssuer & {
  readonly setAuthorize: (value: (attempt: ReturnType<typeof assignment>) => void) => void;
};

export function recoveryIssuerClient(hooks: IssuerHooks): ControllableIssuer {
  let authorizeAttempt: ((value: ReturnType<typeof assignment>) => void) | undefined;
  return {
    setAuthorize(value) { authorizeAttempt = value; },
    async loadDescriptor(context) {
      const value = descriptor(context.event.projectId, context.event.repositoryId, context.admissionGeneration);
      return { reviewId: context.event.reviewId, descriptor: value, digest: nativeDescriptorDigest(value) };
    },
    async issueAttempt(input) {
      const attemptId = "10000000-0000-4000-8000-000000000019";
      const value = assignment(input.descriptor.descriptor, input.context.event.reviewId, attemptId);
      await hooks.issued(input, () => authorizeAttempt?.(value));
      return {
        issuance: {
          schemaVersion: 3, executionKind: "ordinary-sysbox", issuanceRequestId: input.issuanceRequestId, attemptId,
          reviewId: input.context.event.reviewId, attempt: 1, descriptor: input.descriptor.descriptor,
          descriptorDigest: input.descriptor.digest, hostId: input.context.capacity.hostId,
          capacity: input.context.capacity.capacity, issuedBy: "ordinary-attempts", issuedAt: "2026-10-05T00:00:00.000Z"
        }
      };
    },
    async revokeAttempt(issuance) {
      hooks.revoked?.();
      return {
        schemaVersion: 3, executionKind: "ordinary-sysbox", revocationRequestId: issuance.attemptId,
        revocationId: "40000000-0000-4000-8000-000000000019",
        attemptId: issuance.attemptId, reviewId: issuance.reviewId, jobName: issuance.descriptor.jobName,
        attempt: issuance.attempt, descriptorDigest: issuance.descriptorDigest, hostId: issuance.hostId,
        capacity: issuance.capacity, revokedBy: "ordinary-attempts", revokedAt: "2026-10-05T00:00:01.000Z"
      };
    }
  };
}
