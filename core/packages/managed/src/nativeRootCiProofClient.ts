import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createNodeNativeGitAdmissionHttpClient } from "./nativeGitAdmissionHttpClient.js";
import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpRequest,
  NativeGitAdmissionHttpResponse
} from "./nativeGitAdmissionSource.js";
import {
  NativeRootCiProofShapeError,
  parseNativeRootCiPolicyProof,
  parseNativeRootCiReviewEventProof,
  type NativeRootCiPolicyProof,
  type NativeRootCiReviewEventProof,
  type NativeRootCiReviewSelector
} from "./nativeRootCiProofModel.js";

const maximumResponseBytes = 64 * 1024;
const requestTimeoutMilliseconds = 5_000;
const scope = ["imported-policy:read", "ordinary-review-event:read"] as const;
const generationPattern = /^[0-9a-f]{64}$/;
const projectPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type NativeRootCiProofConfig = {
  readonly endpoint: string;
  readonly serviceId: "native-main";
  readonly generationId: string;
  readonly identity: { readonly username: string; readonly password: string };
};
export type NativeRootCiProofHttpClient = NativeGitAdmissionHttpClient;
export interface NativeRootCiProofClient {
  readImportedPolicy(projectId: string, signal: AbortSignal): Promise<NativeRootCiPolicyProof>;
  readOrdinaryReviewEvent(input: NativeRootCiReviewSelector, signal: AbortSignal): Promise<NativeRootCiReviewEventProof>;
}

export function createNativeRootCiProofClient(
  input: NativeRootCiProofConfig,
  httpClient: NativeRootCiProofHttpClient = createNodeNativeGitAdmissionHttpClient()
): NativeRootCiProofClient {
  const endpoint = exactOrigin(input.endpoint);
  if (input.serviceId !== "native-main" || !generationPattern.test(input.generationId)
    || !credentialPart(input.identity.username) || !credentialPart(input.identity.password)) invalidConfig();
  const serviceId = input.serviceId;
  const generationId = input.generationId;
  const authorization = `Basic ${Buffer.from(`${input.identity.username}:${input.identity.password}`, "utf8").toString("base64")}`;
  let attestation: Promise<void> | undefined;

  return {
    async readImportedPolicy(projectId, signal) {
      assertProject(projectId);
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMilliseconds)]);
      await attest(bounded);
      const requestId = randomUUID();
      const value = await requestJson(httpClient, { endpoint, method: "POST", path: proofPath(projectId, "policy"),
        authorization, body: JSON.stringify({ schemaVersion: 1, requestId, generationId }), signal: bounded }, true);
      try {
        return parseNativeRootCiPolicyProof(value, { serviceId, generationId, requestId, projectId });
      } catch (error) {
        if (error instanceof NativeRootCiProofShapeError) throw new NativeRootCiProofUnavailableError({ cause: error });
        throw error;
      }
    },
    async readOrdinaryReviewEvent(selector, signal) {
      assertSelector(selector);
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMilliseconds)]);
      await attest(bounded);
      const requestId = randomUUID();
      const value = await requestJson(httpClient, { endpoint, method: "POST",
        path: proofPath(selector.projectId, "review-event"), authorization,
        body: JSON.stringify({ schemaVersion: 1, requestId, generationId, importNonce: selector.importNonce,
          policyDigest: selector.policyDigest, eventId: selector.eventId, reviewId: selector.reviewId,
          executionKind: selector.executionKind, jobName: selector.jobName }), signal: bounded }, true);
      try {
        return parseNativeRootCiReviewEventProof(value, { serviceId, generationId, requestId,
          projectId: selector.projectId }, selector);
      } catch (error) {
        if (error instanceof NativeRootCiProofShapeError) throw new NativeRootCiProofUnavailableError({ cause: error });
        throw error;
      }
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

  async function attestOnce(signal: AbortSignal): Promise<void> {
    const value = await requestJson(httpClient, { endpoint, method: "GET",
      path: "/v1/native-root-ci-proof/identity", authorization, signal }, false);
    const identity = exactRecord(value, ["schemaVersion", "serviceId", "role", "scope", "generationId"]);
    if (identity.schemaVersion !== 1 || identity.serviceId !== serviceId
      || identity.role !== "native-root-ci-proof-reader" || !isDeepStrictEqual(identity.scope, scope)
      || identity.generationId !== generationId) throw new NativeRootCiProofUnavailableError();
  }
}

async function requestJson(client: NativeRootCiProofHttpClient, input: NativeGitAdmissionHttpRequest,
  rejection: boolean): Promise<unknown> {
  let response: NativeGitAdmissionHttpResponse;
  try {
    response = await client.request(input);
  } catch (error) {
    throw new NativeRootCiProofUnavailableError({ cause: error });
  }
  if (rejection && (response.statusCode === 404 || response.statusCode === 409)) {
    throw new NativeRootCiProofRejectedError(response.statusCode);
  }
  if (response.statusCode !== 200 || response.contentType !== "application/json; charset=utf-8"
    || response.cacheControl !== "no-store" || response.body.length > maximumResponseBytes) {
    throw new NativeRootCiProofUnavailableError();
  }
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new NativeRootCiProofUnavailableError({ cause: error });
    throw error;
  }
}

function assertSelector(selector: NativeRootCiReviewSelector): void {
  assertProject(selector.projectId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(selector.importNonce)
    || !generationPattern.test(selector.policyDigest) || !generationPattern.test(selector.eventId)
    || !generationPattern.test(selector.reviewId) || selector.executionKind !== "ordinary-sysbox"
    || !/^[a-z][a-z0-9-]{0,62}$/.test(selector.jobName)) invalidConfig();
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new NativeRootCiProofUnavailableError();
  }
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)]));
}

function exactOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch (error) {
    if (error instanceof TypeError) throw new NativeRootCiProofConfigError({ cause: error });
    throw error;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== ""
    || url.pathname !== "/" || url.search !== "" || url.hash !== "" || value !== url.origin) invalidConfig();
  return url.origin;
}

function assertProject(value: string): void { if (!projectPattern.test(value)) invalidConfig(); }
function credentialPart(value: string): boolean { return value.length > 0 && !value.includes(":"); }
function proofPath(projectId: string, suffix: "policy" | "review-event"): string {
  return `/v1/projects/${projectId}/repositories/root/native-root-ci-proof/${suffix}`;
}
function invalidConfig(): never { throw new NativeRootCiProofConfigError(); }

export class NativeRootCiProofConfigError extends Error {
  readonly name = "NativeRootCiProofConfigError";
  constructor(options?: ErrorOptions) { super("native root CI proof client configuration is invalid", options); }
}
export class NativeRootCiProofUnavailableError extends Error {
  readonly name = "NativeRootCiProofUnavailableError";
  constructor(options?: ErrorOptions) { super("native root CI proof is unavailable", options); }
}
export class NativeRootCiProofRejectedError extends Error {
  readonly name = "NativeRootCiProofRejectedError";
  constructor(readonly statusCode: 404 | 409) { super("native root CI proof tuple was rejected"); }
}
