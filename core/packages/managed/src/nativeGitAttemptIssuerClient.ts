import { isDeepStrictEqual } from "node:util";
import { UserError } from "@slop-lab/dim-core";
import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpResponse
} from "./nativeGitAdmissionSource.js";
import {
  parseNativeExecutionDescriptor,
  parseNativeJobAttemptIssuance,
  parseNativeJobAttemptRevocation,
  type NativeExecutionDescriptor,
  type NativeJobAttemptIssuance,
  type NativeJobAttemptRevocation
} from "./nativeGitAttemptIssuerModel.js";
import { createNodeNativeGitAdmissionHttpClient } from "./nativeGitAdmissionHttpClient.js";
import {
  NativeGitAttemptIssuerUnavailableError
} from "./nativeGitAttemptIssuerErrors.js";
import {
  assertAttemptIssuerEnvelope,
  exactAttemptIssuerEnvelope,
  requestAttemptIssuerJson
} from "./nativeGitAttemptIssuerWire.js";
import { nativeDescriptorDigest, resourceBounds } from "./nativeOrdinaryAuthorityModel.js";
import {
  parseNativeRootCiClaim,
  type NativeRootCiClaim
} from "./nativeRootCiClaimProtocol.js";
import { NativeRootCiReviewEventError } from "./nativeRootCiReviewEvent.js";

const requestTimeoutMilliseconds = 5_000;

export { NativeGitAttemptIssuerRejectedError, NativeGitAttemptIssuerUnavailableError } from "./nativeGitAttemptIssuerErrors.js";

export type NativeGitAttemptIssuerConfig = {
  readonly endpoint: "http://native-git:8080";
  readonly serviceId: "native-main";
  readonly attemptIssuer: {
    readonly username: string;
    readonly password: string;
  };
};

export type NativeAttemptIssuerContext = {
  readonly claim: NativeRootCiClaim;
};

export type NativeAttemptIssueRequest = {
  readonly context: NativeAttemptIssuerContext;
  readonly descriptor: NativeExecutionDescriptor;
};

export type NativeAttemptIssueResult = {
  readonly issuance: NativeJobAttemptIssuance;
};

export interface NativeGitAttemptIssuerClient {
  loadDescriptor(context: NativeAttemptIssuerContext): Promise<NativeExecutionDescriptor>;
  issueAttempt(input: NativeAttemptIssueRequest): Promise<NativeAttemptIssueResult>;
  revokeAttempt(issuance: NativeJobAttemptIssuance): Promise<NativeJobAttemptRevocation>;
}

export type NativeGitAttemptIssuerHttpClient = NativeGitAdmissionHttpClient;
export type NativeGitAttemptIssuerHttpResponse = NativeGitAdmissionHttpResponse;

export type NativeGitAttemptIssuerClientOptions = {
  readonly config: NativeGitAttemptIssuerConfig;
  readonly httpClient: NativeGitAttemptIssuerHttpClient;
  readonly generationId: string;
};

export function createNodeNativeGitAttemptIssuerClient(
  config: NativeGitAttemptIssuerConfig, generationId: string
): NativeGitAttemptIssuerClient {
  return createNativeGitAttemptIssuerClient({ config, generationId, httpClient: createNodeNativeGitAdmissionHttpClient() });
}

export function createNativeGitAttemptIssuerClient(
  options: NativeGitAttemptIssuerClientOptions
): NativeGitAttemptIssuerClient {
  const endpoint = options.config.endpoint;
  const serviceId = options.config.serviceId;
  const issuerUsername = options.config.attemptIssuer.username;
  const issuerPassword = options.config.attemptIssuer.password;
  const generationId = options.generationId;
  const httpClient = options.httpClient;
  if (endpoint !== "http://native-git:8080" || serviceId !== "native-main"
    || !/^[0-9a-f]{64}$/.test(generationId)) {
    throw new NativeGitAttemptIssuerUnavailableError();
  }
  const authorization = basicAuthorization(issuerUsername, issuerPassword);
  return {
    async loadDescriptor(context) {
      const trusted = parseContext(context);
      const response = await requestAttemptIssuerJson(httpClient, {
        endpoint,
        method: "POST",
        path: reviewPath(trusted.claim.event, "ordinary-execution-descriptors"),
        authorization,
        generationId,
        body: JSON.stringify({
          schemaVersion: 1,
          jobName: trusted.claim.event.jobName,
          trustedCapacity: {
            admissionGeneration: trusted.claim.admissionGeneration,
            jobBaseImage: trusted.claim.jobBaseImage,
            runnerBaseImage: trusted.claim.runnerBaseImage,
            bounds: trusted.claim.bounds
          }
        }),
        signal: AbortSignal.timeout(requestTimeoutMilliseconds)
      }, [200]);
      const envelope = exactAttemptIssuerEnvelope(response.body, [
        "schemaVersion", "serviceId", "servingGenerationId", "kind", "reviewId", "descriptor", "digest"
      ]);
      assertAttemptIssuerEnvelope(envelope, serviceId, generationId);
      if (envelope.kind !== "ordinary-sysbox") throw new NativeGitAttemptIssuerUnavailableError();
      const descriptor = parseResponse(() => parseNativeExecutionDescriptor({
        reviewId: envelope.reviewId,
        descriptor: envelope.descriptor,
        digest: envelope.digest
      }));
      assertDescriptorBinding(descriptor, trusted);
      return descriptor;
    },
    async issueAttempt(input) {
      const trusted = parseContext(input.context);
      const requestedDescriptor = parseResponse(() => parseNativeExecutionDescriptor(input.descriptor));
      assertDescriptorBinding(requestedDescriptor, trusted);
      const response = await requestAttemptIssuerJson(httpClient, {
        endpoint,
        method: "POST",
        path: reviewPath(trusted.claim.event, "job-attempts"),
        authorization,
        generationId,
        body: JSON.stringify({
          schemaVersion: 1,
          descriptorDigest: requestedDescriptor.digest,
          claim: trusted.claim
        }),
        signal: AbortSignal.timeout(requestTimeoutMilliseconds)
      }, [201]);
      const envelope = exactAttemptIssuerEnvelope(response.body, [
        "schemaVersion", "serviceId", "servingGenerationId", "attempt"
      ]);
      assertAttemptIssuerEnvelope(envelope, serviceId, generationId);
      const issuance = parseResponse(() => parseNativeJobAttemptIssuance(envelope.attempt));
      if (issuance.issuanceRequestId !== trusted.claim.issuanceRequestId
        || issuance.reviewId !== trusted.claim.event.reviewId
        || issuance.descriptorDigest !== requestedDescriptor.digest
        || !isDeepStrictEqual(issuance.descriptor, requestedDescriptor.descriptor)
        || issuance.hostId !== trusted.claim.hostId || issuance.capacity !== trusted.claim.capacity
        || issuance.issuedBy !== issuerUsername) {
        throw new NativeGitAttemptIssuerUnavailableError();
      }
      return { issuance };
    },
    async revokeAttempt(issuance) {
      const trusted = parseResponse(() => parseNativeJobAttemptIssuance(issuance));
      if (trusted.descriptorDigest !== nativeDescriptorDigest(trusted.descriptor)
        || trusted.issuedBy !== issuerUsername) {
        throw new NativeGitAttemptIssuerUnavailableError();
      }
      const response = await requestAttemptIssuerJson(httpClient, {
        endpoint,
        method: "POST",
        path: `/v1/projects/${trusted.descriptor.projectId}/repositories/${trusted.descriptor.repositoryId}`
          + `/reviews/${trusted.reviewId}/job-attempt-revocations`,
        authorization,
        generationId,
        body: JSON.stringify({
          schemaVersion: 1,
          revocationRequestId: trusted.attemptId,
          jobName: trusted.descriptor.jobName,
          attemptId: trusted.attemptId
        }),
        signal: AbortSignal.timeout(requestTimeoutMilliseconds)
      }, [201]);
      const envelope = exactAttemptIssuerEnvelope(response.body, [
        "schemaVersion", "serviceId", "servingGenerationId", "revocation"
      ]);
      assertAttemptIssuerEnvelope(envelope, serviceId, generationId);
      const revocation = parseResponse(() => parseNativeJobAttemptRevocation(envelope.revocation));
      if (revocation.attemptId !== trusted.attemptId || revocation.reviewId !== trusted.reviewId
        || revocation.revocationRequestId !== trusted.attemptId
        || revocation.jobName !== trusted.descriptor.jobName || revocation.attempt !== trusted.attempt
        || revocation.descriptorDigest !== trusted.descriptorDigest || revocation.hostId !== trusted.hostId
        || revocation.capacity !== trusted.capacity || revocation.revokedBy !== issuerUsername) {
        throw new NativeGitAttemptIssuerUnavailableError();
      }
      return revocation;
    }
  };
}

function parseContext(context: NativeAttemptIssuerContext): NativeAttemptIssuerContext {
  const claim = parseResponse(() => parseNativeRootCiClaim(context.claim));
  return { claim: { ...claim, bounds: parseResponse(() => resourceBounds(claim.bounds)) } };
}

function assertDescriptorBinding(descriptor: NativeExecutionDescriptor, context: NativeAttemptIssuerContext): void {
  const expected = {
    projectId: context.claim.event.projectId, repositoryId: context.claim.event.repositoryId,
    protectedRef: context.claim.event.protectedRef, expectedProtectedHead: context.claim.event.expectedProtectedHead,
    candidateCommit: context.claim.event.candidateCommit, candidateTree: context.claim.event.candidateTree,
    policyRevision: context.claim.event.policyRevision,
    requiredReviewRevision: context.claim.event.requiredReviewRevision,
    requiredJobSetRevision: context.claim.event.qualityRevision,
    admissionGeneration: context.claim.admissionGeneration,
    jobName: context.claim.event.jobName, jobImage: context.claim.jobBaseImage,
    runnerBaseImage: context.claim.runnerBaseImage, bounds: context.claim.bounds,
    evidenceClass: context.claim.event.evidenceClass
  };
  const actual = {
    projectId: descriptor.descriptor.projectId, repositoryId: descriptor.descriptor.repositoryId,
    protectedRef: descriptor.descriptor.protectedRef, expectedProtectedHead: descriptor.descriptor.expectedProtectedHead,
    candidateCommit: descriptor.descriptor.candidateCommit, candidateTree: descriptor.descriptor.candidateTree,
    policyRevision: descriptor.descriptor.policyRevision, requiredReviewRevision: descriptor.descriptor.requiredReviewRevision,
    requiredJobSetRevision: descriptor.descriptor.requiredJobSetRevision,
    admissionGeneration: descriptor.descriptor.admissionGeneration, jobName: descriptor.descriptor.jobName,
    jobImage: descriptor.descriptor.jobImage, runnerBaseImage: descriptor.descriptor.runnerBaseImage,
    bounds: descriptor.descriptor.bounds,
    evidenceClass: descriptor.descriptor.evidenceClass
  };
  if (descriptor.reviewId !== context.claim.event.reviewId
    || descriptor.digest !== nativeDescriptorDigest(descriptor.descriptor)
    || !isDeepStrictEqual(actual, expected)) throw new NativeGitAttemptIssuerUnavailableError();
}

function parseResponse<T>(parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    if (error instanceof UserError || error instanceof NativeRootCiReviewEventError) {
      throw new NativeGitAttemptIssuerUnavailableError({ cause: error });
    }
    throw error;
  }
}

function reviewPath(event: NativeRootCiClaim["event"], action: "ordinary-execution-descriptors" | "job-attempts"): string {
  return `/v1/projects/${event.projectId}/repositories/${event.repositoryId}/reviews/${event.reviewId}/${action}`;
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}
