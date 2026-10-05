import { isDeepStrictEqual } from "node:util";
import { UserError } from "./errors.js";
import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpRequest,
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
import { nativeDescriptorDigest, resourceBounds } from "./nativeOrdinaryAuthorityModel.js";
import type { NativeCapacityPolicy } from "./nativeOrdinaryAuthorityProtocol.js";
import { parseNativeReviewJobEvent, type NativeReviewJobEvent } from "./nativeOrdinaryEvent.js";

const maximumResponseBytes = 64 * 1024;
const requestTimeoutMilliseconds = 5_000;
const rejectionStatuses = [400, 401, 403, 404, 409] as const;

export type NativeGitAttemptIssuerConfig = {
  readonly endpoint: "http://native-git:8080";
  readonly serviceId: "native-main";
  readonly attemptIssuer: {
    readonly username: string;
    readonly password: string;
  };
};

export type NativeAttemptIssuerContext = {
  readonly event: NativeReviewJobEvent;
  readonly admissionGeneration: string;
  readonly capacity: NativeCapacityPolicy;
};

export type NativeAttemptIssueRequest = {
  readonly issuanceRequestId: string;
  readonly context: NativeAttemptIssuerContext;
  readonly descriptor: NativeExecutionDescriptor;
};

export type NativeAttemptIssueResult = {
  readonly issuance: NativeJobAttemptIssuance;
  readonly replayed: boolean;
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
};

export function createNodeNativeGitAttemptIssuerClient(
  config: NativeGitAttemptIssuerConfig
): NativeGitAttemptIssuerClient {
  return createNativeGitAttemptIssuerClient({ config, httpClient: createNodeNativeGitAdmissionHttpClient() });
}

export function createNativeGitAttemptIssuerClient(
  options: NativeGitAttemptIssuerClientOptions
): NativeGitAttemptIssuerClient {
  const endpoint = options.config.endpoint;
  const serviceId = options.config.serviceId;
  const issuerUsername = options.config.attemptIssuer.username;
  const issuerPassword = options.config.attemptIssuer.password;
  const httpClient = options.httpClient;
  if (endpoint !== "http://native-git:8080" || serviceId !== "native-main") {
    throw new NativeGitAttemptIssuerUnavailableError();
  }
  const authorization = basicAuthorization(issuerUsername, issuerPassword);
  return {
    async loadDescriptor(context) {
      const trusted = parseContext(context);
      const response = await requestJson(httpClient, {
        endpoint,
        method: "POST",
        path: reviewPath(trusted.event, "ordinary-execution-descriptors"),
        authorization,
        body: JSON.stringify({
          jobName: trusted.event.jobName,
          admissionGeneration: trusted.admissionGeneration,
          runnerBaseImage: trusted.capacity.runnerBaseImage,
          bounds: trusted.capacity.bounds
        }),
        signal: AbortSignal.timeout(requestTimeoutMilliseconds)
      }, [200]);
      const descriptor = parseResponse(() => parseNativeExecutionDescriptor(response.body));
      assertDescriptorBinding(descriptor, trusted);
      return descriptor;
    },
    async issueAttempt(input) {
      const issuanceRequestId = input.issuanceRequestId;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(issuanceRequestId)) {
        throw new NativeGitAttemptIssuerUnavailableError();
      }
      const trusted = parseContext(input.context);
      const requestedDescriptor = parseResponse(() => parseNativeExecutionDescriptor(input.descriptor));
      assertDescriptorBinding(requestedDescriptor, trusted);
      const response = await requestJson(httpClient, {
        endpoint,
        method: "POST",
        path: reviewPath(trusted.event, "job-attempts"),
        authorization,
        body: JSON.stringify({
          issuanceRequestId,
          jobName: trusted.event.jobName,
          descriptorDigest: requestedDescriptor.digest,
          admissionGeneration: trusted.admissionGeneration,
          runnerBaseImage: trusted.capacity.runnerBaseImage,
          bounds: trusted.capacity.bounds,
          hostId: trusted.capacity.hostId,
          capacity: trusted.capacity.capacity
        }),
        signal: AbortSignal.timeout(requestTimeoutMilliseconds)
      }, [200, 201]);
      const issuance = parseResponse(() => parseNativeJobAttemptIssuance(response.body));
      if (issuance.issuanceRequestId !== issuanceRequestId
        || issuance.reviewId !== trusted.event.reviewId
        || issuance.descriptorDigest !== requestedDescriptor.digest
        || !isDeepStrictEqual(issuance.descriptor, requestedDescriptor.descriptor)
        || issuance.hostId !== trusted.capacity.hostId || issuance.capacity !== trusted.capacity.capacity
        || issuance.issuedBy !== issuerUsername) {
        throw new NativeGitAttemptIssuerUnavailableError();
      }
      return { issuance, replayed: response.statusCode === 200 };
    },
    async revokeAttempt(issuance) {
      const trusted = parseResponse(() => parseNativeJobAttemptIssuance(issuance));
      if (trusted.descriptorDigest !== nativeDescriptorDigest(trusted.descriptor)
        || trusted.issuedBy !== issuerUsername) {
        throw new NativeGitAttemptIssuerUnavailableError();
      }
      const response = await requestJson(httpClient, {
        endpoint,
        method: "POST",
        path: `/v1/projects/${trusted.descriptor.projectId}/repositories/${trusted.descriptor.repositoryId}`
          + `/reviews/${trusted.reviewId}/job-attempt-revocations`,
        authorization,
        body: JSON.stringify({ jobName: trusted.descriptor.jobName, attemptId: trusted.attemptId }),
        signal: AbortSignal.timeout(requestTimeoutMilliseconds)
      }, [201]);
      const revocation = parseResponse(() => parseNativeJobAttemptRevocation(response.body));
      if (revocation.attemptId !== trusted.attemptId || revocation.reviewId !== trusted.reviewId
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
  const event = parseResponse(() => parseNativeReviewJobEvent(context.event));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(context.admissionGeneration)
    || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(context.capacity.hostId)
    || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(context.capacity.capacity)
    || !/^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/.test(context.capacity.runnerBaseImage)) {
    throw new NativeGitAttemptIssuerUnavailableError();
  }
  const bounds = parseResponse(() => resourceBounds(context.capacity.bounds));
  return { event, admissionGeneration: context.admissionGeneration, capacity: { ...context.capacity, bounds } };
}

function assertDescriptorBinding(descriptor: NativeExecutionDescriptor, context: NativeAttemptIssuerContext): void {
  const expected = {
    projectId: context.event.projectId, repositoryId: context.event.repositoryId,
    protectedRef: context.event.protectedRef, expectedProtectedHead: context.event.expectedProtectedHead,
    candidateCommit: context.event.candidateCommit, candidateTree: context.event.candidateTree,
    policyRevision: context.event.policyRevision, requiredReviewRevision: context.event.requiredReviewRevision,
    requiredJobSetRevision: context.event.requiredJobSetRevision, admissionGeneration: context.admissionGeneration,
    jobName: context.event.jobName, runnerBaseImage: context.capacity.runnerBaseImage, bounds: context.capacity.bounds,
    evidenceClass: context.event.evidenceClass
  };
  const actual = {
    projectId: descriptor.descriptor.projectId, repositoryId: descriptor.descriptor.repositoryId,
    protectedRef: descriptor.descriptor.protectedRef, expectedProtectedHead: descriptor.descriptor.expectedProtectedHead,
    candidateCommit: descriptor.descriptor.candidateCommit, candidateTree: descriptor.descriptor.candidateTree,
    policyRevision: descriptor.descriptor.policyRevision, requiredReviewRevision: descriptor.descriptor.requiredReviewRevision,
    requiredJobSetRevision: descriptor.descriptor.requiredJobSetRevision,
    admissionGeneration: descriptor.descriptor.admissionGeneration, jobName: descriptor.descriptor.jobName,
    runnerBaseImage: descriptor.descriptor.runnerBaseImage, bounds: descriptor.descriptor.bounds,
    evidenceClass: descriptor.descriptor.evidenceClass
  };
  if (descriptor.reviewId !== context.event.reviewId || descriptor.digest !== nativeDescriptorDigest(descriptor.descriptor)
    || !isDeepStrictEqual(actual, expected)) throw new NativeGitAttemptIssuerUnavailableError();
}

async function requestJson(
  client: NativeGitAttemptIssuerHttpClient,
  input: NativeGitAdmissionHttpRequest,
  successStatuses: readonly number[]
): Promise<{ readonly statusCode: number; readonly body: unknown }> {
  let response: NativeGitAttemptIssuerHttpResponse;
  try {
    response = await client.request(input);
  } catch (error) {
    throw new NativeGitAttemptIssuerUnavailableError({ cause: error });
  }
  if (rejectionStatuses.some((status) => status === response.statusCode)) {
    throw new NativeGitAttemptIssuerRejectedError(response.statusCode);
  }
  if (!successStatuses.includes(response.statusCode) || response.contentType !== "application/json; charset=utf-8"
    || response.cacheControl !== "no-store" || response.body.length > maximumResponseBytes) {
    throw new NativeGitAttemptIssuerUnavailableError();
  }
  try {
    return { statusCode: response.statusCode, body: JSON.parse(response.body.toString("utf8")) };
  } catch (error) {
    if (error instanceof SyntaxError) throw new NativeGitAttemptIssuerUnavailableError({ cause: error });
    throw error;
  }
}

function parseResponse<T>(parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    if (error instanceof UserError) throw new NativeGitAttemptIssuerUnavailableError({ cause: error });
    throw error;
  }
}

function reviewPath(event: NativeReviewJobEvent, action: "ordinary-execution-descriptors" | "job-attempts"): string {
  return `/v1/projects/${event.projectId}/repositories/${event.repositoryId}/reviews/${event.reviewId}/${action}`;
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export class NativeGitAttemptIssuerUnavailableError extends Error {
  readonly name = "NativeGitAttemptIssuerUnavailableError";

  constructor(options?: ErrorOptions) {
    super("native Git attempt issuer is unavailable", options);
  }
}

export class NativeGitAttemptIssuerRejectedError extends Error {
  readonly name = "NativeGitAttemptIssuerRejectedError";

  constructor(readonly statusCode: number) {
    super("native Git rejected the attempt issuer request");
  }
}
