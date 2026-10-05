import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { UserError } from "./errors.js";
import {
  parseNativeAdmissionPolicy,
  parseNativeAttemptAssignment,
  type NativeAdmissionPolicy,
  type NativeAttemptAssignment
} from "./nativeOrdinaryAuthorityModel.js";
import { parseNativeReviewJobEvent, type NativeReviewJobEvent } from "./nativeOrdinaryEvent.js";
export { createNodeNativeGitAdmissionHttpClient } from "./nativeGitAdmissionHttpClient.js";

const maximumResponseBytes = 64 * 1024;
const requestTimeoutMilliseconds = 5_000;
const authorityScope = ["policy:read", "review-event:read", "attempt:read"] as const;
const proofRejectionStatuses = [404] as const;

export type NativeGitAdmissionConfig = {
  readonly endpoint: "http://native-git:8080";
  readonly serviceId: "native-main";
  readonly identity: {
    readonly username: string;
    readonly password: string;
  };
  readonly attemptIssuer: {
    readonly username: string;
    readonly password: string;
  };
};

export interface NativeAdmissionSource {
  assertRegisteredPolicy(input: NativeAdmissionPolicy): Promise<NativeAdmissionPolicy>;
  assertReviewEvent(input: NativeReviewJobEvent): Promise<NativeReviewJobEvent>;
  assertIssuedAttempt(input: NativeAttemptAssignment): Promise<NativeAttemptAssignment>;
}

export type NativeGitAdmissionHttpRequest = {
  readonly endpoint: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly authorization: string;
  readonly body?: string;
  readonly signal: AbortSignal;
};

export type NativeGitAdmissionHttpResponse = {
  readonly statusCode: number;
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
  readonly body: Buffer;
};

export interface NativeGitAdmissionHttpClient {
  request(input: NativeGitAdmissionHttpRequest): Promise<NativeGitAdmissionHttpResponse>;
}

export type NativeGitAdmissionSourceOptions = {
  readonly config: NativeGitAdmissionConfig;
  readonly httpClient: NativeGitAdmissionHttpClient;
};

export function createNativeGitAdmissionSource(options: NativeGitAdmissionSourceOptions): NativeAdmissionSource {
  const endpoint = options.config.endpoint;
  const serviceId = options.config.serviceId;
  const identityUsername = options.config.identity.username;
  const identityPassword = options.config.identity.password;
  const authorization = basicAuthorization(identityUsername, identityPassword);
  const httpClient = options.httpClient;
  let attestation: Promise<void> | undefined;

  return {
    async assertRegisteredPolicy(input) {
      const signal = AbortSignal.timeout(requestTimeoutMilliseconds);
      await attest(signal);
      const canonical = await readPolicy(input, signal);
      if (!isDeepStrictEqual(canonical, input)) throw new NativeAdmissionSourceRejectedError();
      return canonical;
    },
    async assertReviewEvent(input) {
      const signal = AbortSignal.timeout(requestTimeoutMilliseconds);
      await attest(signal);
      const requestId = randomUUID();
      const response = await requestJson(httpClient, {
        endpoint,
        method: "POST",
        path: proofPath(input.projectId, input.repositoryId, "review-event"),
        authorization,
        body: JSON.stringify({
          schemaVersion: 1,
          requestId,
          eventId: input.eventId,
          reviewId: input.reviewId,
          jobName: input.jobName
        }),
        signal
      }, proofRejectionStatuses);
      const outer = exactRecord(response, ["schemaVersion", "serviceId", "requestId", "event"]);
      if (outer.schemaVersion !== 1 || outer.serviceId !== serviceId || outer.requestId !== requestId) {
        throw new NativeAdmissionSourceUnavailableError();
      }
      const canonical = parseProof(() => parseNativeReviewJobEvent(outer.event));
      if (!isDeepStrictEqual(canonical, input)) throw new NativeAdmissionSourceRejectedError();
      return canonical;
    },
    async assertIssuedAttempt(input) {
      const signal = AbortSignal.timeout(requestTimeoutMilliseconds);
      await attest(signal);
      const requestId = randomUUID();
      const response = await requestJson(httpClient, {
        endpoint,
        method: "POST",
        path: proofPath(input.descriptor.projectId, input.descriptor.repositoryId, "current-attempt"),
        authorization,
        body: JSON.stringify({
          schemaVersion: 1,
          requestId,
          reviewId: input.reviewId,
          jobName: input.descriptor.jobName,
          attemptId: input.attemptId
        }),
        signal
      }, proofRejectionStatuses);
      const outer = exactRecord(response, ["schemaVersion", "serviceId", "requestId", "assignment"]);
      if (outer.schemaVersion !== 1 || outer.serviceId !== serviceId || outer.requestId !== requestId) {
        throw new NativeAdmissionSourceUnavailableError();
      }
      const canonical = parseProof(() => parseNativeAttemptAssignment(outer.assignment));
      if (!isDeepStrictEqual(canonical, input)) throw new NativeAdmissionSourceRejectedError();
      return canonical;
    }
  };

  async function attest(signal: AbortSignal): Promise<void> {
    if (attestation === undefined) attestation = attestOnce(signal);
    const current = attestation;
    try {
      await current;
    } catch (error) {
      if (attestation === current) attestation = undefined;
      throw error;
    }
  }

  async function readPolicy(
    identity: Pick<NativeAdmissionPolicy, "projectId" | "repositoryId" | "protectedRef">,
    signal: AbortSignal
  ): Promise<NativeAdmissionPolicy> {
    const requestId = randomUUID();
    const response = await requestJson(httpClient, {
      endpoint,
      method: "POST",
      path: proofPath(identity.projectId, identity.repositoryId, "policy"),
      authorization,
      body: JSON.stringify({ schemaVersion: 1, requestId, protectedRef: identity.protectedRef }),
      signal
    }, proofRejectionStatuses);
    const outer = exactRecord(response, ["schemaVersion", "serviceId", "requestId", "policy"]);
    if (outer.schemaVersion !== 1 || outer.serviceId !== serviceId || outer.requestId !== requestId) {
      throw new NativeAdmissionSourceUnavailableError();
    }
    const policy = exactRecord(outer.policy, [
      "schemaVersion", "projectId", "repositoryId", "protectedRef", "policyRevision",
      "requiredReviewRevision", "requiredJobSetRevision", "requiredJobs"
    ]);
    return parseProof(() => parseNativeAdmissionPolicy(policy));
  }

  async function attestOnce(signal: AbortSignal): Promise<void> {
    const response = await requestJson(httpClient, {
      endpoint,
      method: "GET",
      path: "/v1/ordinary-authority/identity",
      authorization,
      signal
    }, []);
    const identity = exactRecord(response, ["schemaVersion", "serviceId", "role", "scope"]);
    if (identity.schemaVersion !== 1 || identity.serviceId !== serviceId
      || identity.role !== "ordinary-authority-reader" || !isDeepStrictEqual(identity.scope, authorityScope)) {
      throw new NativeAdmissionSourceUnavailableError();
    }
  }
}

async function requestJson(
  client: NativeGitAdmissionHttpClient,
  input: NativeGitAdmissionHttpRequest,
  rejectionStatuses: readonly number[]
): Promise<unknown> {
  let response: NativeGitAdmissionHttpResponse;
  try {
    response = await client.request(input);
  } catch (error) {
    throw new NativeAdmissionSourceUnavailableError({ cause: error });
  }
  if (rejectionStatuses.includes(response.statusCode)) throw new NativeAdmissionSourceRejectedError();
  if (response.statusCode !== 200 || response.contentType !== "application/json; charset=utf-8"
    || response.cacheControl !== "no-store" || response.body.length > maximumResponseBytes) {
    throw new NativeAdmissionSourceUnavailableError();
  }
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new NativeAdmissionSourceUnavailableError({ cause: error });
    throw error;
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NativeAdmissionSourceUnavailableError();
  }
  if (Object.keys(value).length !== keys.length || keys.some((key) => Reflect.get(value, key) === undefined)) {
    throw new NativeAdmissionSourceUnavailableError();
  }
  return Object.fromEntries(keys.map((key) => [key, Reflect.get(value, key)]));
}

function parseProof<T>(parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    if (error instanceof UserError) throw new NativeAdmissionSourceUnavailableError({ cause: error });
    throw error;
  }
}

function proofPath(projectId: string, repositoryId: string, proof: "policy" | "review-event" | "current-attempt"): string {
  return `/v1/projects/${projectId}/repositories/${repositoryId}/ordinary-authority/${proof}`;
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export class NativeAdmissionSourceUnavailableError extends Error {
  readonly name = "NativeAdmissionSourceUnavailableError";

  constructor(options?: ErrorOptions) {
    super("native admission source is unavailable", options);
  }
}

export class NativeAdmissionSourceRejectedError extends Error {
  readonly name = "NativeAdmissionSourceRejectedError";

  constructor() {
    super("native admission source rejected the tuple");
  }
}
