import { isDeepStrictEqual } from "node:util";
import {
  NativeGitAttemptIssuerUnavailableError,
  type NativeAttemptIssueResult
} from "../../../../core/packages/core/src/nativeGitAttemptIssuerClient.js";
import {
  parseNativeExecutionDescriptor,
  parseNativeJobAttemptIssuance,
  parseNativeJobAttemptRevocation,
  type NativeExecutionDescriptor,
  type NativeJobAttemptIssuance,
  type NativeJobAttemptRevocation
} from "../../../../core/packages/core/src/nativeGitAttemptIssuerModel.js";
import { requestAttemptIssuerJson } from "../../../../core/packages/core/src/nativeGitAttemptIssuerWire.js";
import type { NativeGitAdmissionHttpClient } from "../../../../core/packages/core/src/nativeGitAdmissionSource.js";
import { nativeDescriptorDigest } from "../../../../core/packages/core/src/nativeOrdinaryAuthorityModel.js";
import type {
  LegacyAttemptContext,
  LegacyNativeAttemptIssuer
} from "../../../../core/packages/core/src/nativeOrdinaryClaimService.js";
import {
  jobAttemptRevocationSchema,
  jobAttemptSchema
} from "../../../../core/packages/native-git/src/job-attempt-schema.js";

const requestTimeoutMilliseconds = 5_000;
const endpoint = "http://native-git:8080";

type StandaloneAttemptIssuerOptions = {
  readonly httpClient: NativeGitAdmissionHttpClient;
  readonly credential: {
    readonly username: string;
    readonly password: string;
  };
};

export function createStandaloneNativeAttemptIssuer(
  options: StandaloneAttemptIssuerOptions
): LegacyNativeAttemptIssuer {
  const authorization = `Basic ${Buffer.from(
    `${options.credential.username}:${options.credential.password}`,
    "utf8"
  ).toString("base64")}`;
  return {
    async loadDescriptor(context) {
      const response = await request({
        httpClient: options.httpClient,
        authorization,
        context,
        action: "ordinary-execution-descriptors",
        body: {
          admissionGeneration: context.admissionGeneration,
          jobName: context.event.jobName,
          jobBaseImage: context.capacity.jobBaseImage,
          runnerBaseImage: context.capacity.runnerBaseImage,
          bounds: context.capacity.bounds
        },
        statuses: [200]
      });
      const descriptor = parseResponse(() => parseNativeExecutionDescriptor(response));
      assertDescriptorBinding(descriptor, context);
      return descriptor;
    },
    async issueAttempt(input): Promise<NativeAttemptIssueResult> {
      const descriptor = parseResponse(() => parseNativeExecutionDescriptor(input.descriptor));
      assertDescriptorBinding(descriptor, input.context);
      const response = await request({
        httpClient: options.httpClient,
        authorization,
        context: input.context,
        action: "job-attempts",
        body: {
          admissionGeneration: input.context.admissionGeneration,
          jobName: input.context.event.jobName,
          jobBaseImage: input.context.capacity.jobBaseImage,
          runnerBaseImage: input.context.capacity.runnerBaseImage,
          bounds: input.context.capacity.bounds,
          issuanceRequestId: input.issuanceRequestId,
          descriptorDigest: descriptor.digest,
          hostId: input.context.capacity.hostId,
          capacity: input.context.capacity.capacity
        },
        statuses: [200, 201]
      });
      const standalone = parseResponse(() => jobAttemptSchema.parse(response));
      const issuance = parseResponse(() => parseNativeJobAttemptIssuance({
        ...standalone,
        schemaVersion: 3,
        executionKind: "ordinary-sysbox"
      }));
      assertIssuanceBinding(issuance, {
        issuanceRequestId: input.issuanceRequestId,
        descriptor,
        context: input.context,
        issuerUsername: options.credential.username
      });
      return { issuance };
    },
    async revokeAttempt(issuance): Promise<NativeJobAttemptRevocation> {
      const trusted = parseResponse(() => parseNativeJobAttemptIssuance(issuance));
      const response = await request({
        httpClient: options.httpClient,
        authorization,
        context: {
          event: {
            projectId: trusted.descriptor.projectId,
            repositoryId: trusted.descriptor.repositoryId,
            reviewId: trusted.reviewId
          }
        },
        action: "job-attempt-revocations",
        body: {
          jobName: trusted.descriptor.jobName,
          attemptId: trusted.attemptId
        },
        statuses: [201]
      });
      const standalone = parseResponse(() => jobAttemptRevocationSchema.parse(response));
      const revocation = parseResponse(() => parseNativeJobAttemptRevocation({
        ...standalone,
        schemaVersion: 3,
        executionKind: "ordinary-sysbox",
        revocationRequestId: trusted.attemptId
      }));
      assertRevocationBinding(revocation, trusted, options.credential.username);
      return revocation;
    }
  };
}

type AttemptRouteContext = {
  readonly event: {
    readonly projectId: string;
    readonly repositoryId: string;
    readonly reviewId: string;
  };
};

type StandaloneRequest = {
  readonly httpClient: NativeGitAdmissionHttpClient;
  readonly authorization: string;
  readonly context: AttemptRouteContext;
  readonly action: "ordinary-execution-descriptors" | "job-attempts" | "job-attempt-revocations";
  readonly body: object;
  readonly statuses: readonly number[];
};

async function request(input: StandaloneRequest): Promise<unknown> {
  const response = await requestAttemptIssuerJson(input.httpClient, {
    endpoint,
    method: "POST",
    path: `/v1/projects/${input.context.event.projectId}/repositories/${input.context.event.repositoryId}`
      + `/reviews/${input.context.event.reviewId}/${input.action}`,
    authorization: input.authorization,
    body: JSON.stringify(input.body),
    signal: AbortSignal.timeout(requestTimeoutMilliseconds)
  }, input.statuses);
  return response.body;
}

function assertDescriptorBinding(descriptor: NativeExecutionDescriptor, context: LegacyAttemptContext): void {
  const expected = {
    projectId: context.event.projectId,
    repositoryId: context.event.repositoryId,
    protectedRef: context.event.protectedRef,
    expectedProtectedHead: context.event.expectedProtectedHead,
    candidateCommit: context.event.candidateCommit,
    candidateTree: context.event.candidateTree,
    policyRevision: context.event.policyRevision,
    requiredReviewRevision: context.event.requiredReviewRevision,
    requiredJobSetRevision: context.event.requiredJobSetRevision,
    admissionGeneration: context.admissionGeneration,
    jobName: context.event.jobName,
    runnerBaseImage: context.capacity.runnerBaseImage,
    bounds: context.capacity.bounds,
    evidenceClass: context.event.evidenceClass,
    jobImage: context.capacity.jobBaseImage
  };
  const actual = {
    projectId: descriptor.descriptor.projectId,
    repositoryId: descriptor.descriptor.repositoryId,
    protectedRef: descriptor.descriptor.protectedRef,
    expectedProtectedHead: descriptor.descriptor.expectedProtectedHead,
    candidateCommit: descriptor.descriptor.candidateCommit,
    candidateTree: descriptor.descriptor.candidateTree,
    policyRevision: descriptor.descriptor.policyRevision,
    requiredReviewRevision: descriptor.descriptor.requiredReviewRevision,
    requiredJobSetRevision: descriptor.descriptor.requiredJobSetRevision,
    admissionGeneration: descriptor.descriptor.admissionGeneration,
    jobName: descriptor.descriptor.jobName,
    runnerBaseImage: descriptor.descriptor.runnerBaseImage,
    bounds: descriptor.descriptor.bounds,
    evidenceClass: descriptor.descriptor.evidenceClass,
    jobImage: descriptor.descriptor.jobImage
  };
  if (descriptor.reviewId !== context.event.reviewId
    || descriptor.digest !== nativeDescriptorDigest(descriptor.descriptor)
    || !isDeepStrictEqual(actual, expected)) {
    throw new NativeGitAttemptIssuerUnavailableError();
  }
}

type ExpectedIssuance = {
  readonly issuanceRequestId: string;
  readonly descriptor: NativeExecutionDescriptor;
  readonly context: LegacyAttemptContext;
  readonly issuerUsername: string;
};

function assertIssuanceBinding(issuance: NativeJobAttemptIssuance, expected: ExpectedIssuance): void {
  if (issuance.issuanceRequestId !== expected.issuanceRequestId
    || issuance.reviewId !== expected.context.event.reviewId
    || issuance.descriptorDigest !== expected.descriptor.digest
    || !isDeepStrictEqual(issuance.descriptor, expected.descriptor.descriptor)
    || issuance.hostId !== expected.context.capacity.hostId
    || issuance.capacity !== expected.context.capacity.capacity
    || issuance.issuedBy !== expected.issuerUsername) {
    throw new NativeGitAttemptIssuerUnavailableError();
  }
}

function assertRevocationBinding(
  revocation: NativeJobAttemptRevocation,
  issuance: NativeJobAttemptIssuance,
  issuerUsername: string
): void {
  if (revocation.revocationRequestId !== issuance.attemptId || revocation.attemptId !== issuance.attemptId
    || revocation.reviewId !== issuance.reviewId || revocation.jobName !== issuance.descriptor.jobName
    || revocation.attempt !== issuance.attempt || revocation.descriptorDigest !== issuance.descriptorDigest
    || revocation.hostId !== issuance.hostId || revocation.capacity !== issuance.capacity
    || revocation.revokedBy !== issuerUsername) {
    throw new NativeGitAttemptIssuerUnavailableError();
  }
}

function parseResponse<Result>(parser: () => Result): Result {
  try {
    return parser();
  } catch (error) {
    if (error instanceof Error) {
      throw new NativeGitAttemptIssuerUnavailableError({ cause: error });
    }
    throw error;
  }
}
