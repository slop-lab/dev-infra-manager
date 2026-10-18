import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createNodeNativeGitAdmissionHttpClient,
  type NativeGitAdmissionHttpClient
} from "./nativeGitAdmissionSource.js";
import { parseNativeJobAttemptIssuance, type NativeJobAttemptIssuance } from "./nativeGitAttemptIssuerModel.js";
import type { NativeCandidateLease } from "./nativeCandidateLease.js";
import {
  parseNativeRootCiActiveClaim,
  parseNativeRootCiClaimActivationRequest,
  parseNativeRootCiClaimLeaseRequest,
  parseNativeRootCiClaimRecoveryRequest,
  nativeRootCiAttemptAssignment,
  type NativeRootCiActiveClaim,
  type NativeRootCiClaimActivationRequest,
  type NativeRootCiClaimLeaseRequest,
  type NativeRootCiClaimRecoveryRequest
} from "./nativeRootCiClaimLifecycleProtocol.js";
import {
  parseNativeRootCiClaim,
  parseNativeRootCiClaimRequest,
  type NativeRootCiClaim,
  type NativeRootCiClaimRequest
} from "./nativeRootCiClaimProtocol.js";
import {
  parseNativeRootCiHostResultRequest,
  type NativeRootCiHostResultRequest
} from "./nativeRootCiResultProtocol.js";
import {
  exactRecord,
  NativeRootCiHostClientError,
  parsePrepared,
  prepared,
  sendEmpty,
  sendGet,
  sendJson,
  type NativeRootCiHostPreparedRequest
} from "./nativeRootCiHostClientWire.js";

export { NativeRootCiHostClientError, NativeRootCiHostRejectedError } from "./nativeRootCiHostClientWire.js";
export type { NativeRootCiHostPreparedRequest } from "./nativeRootCiHostClientWire.js";

type Credential = { readonly username: string; readonly password: string };
export type NativeRootCiHostClientConfig = {
  readonly hostId: string;
  readonly capacity: string;
  readonly generationId: string;
  readonly ordinaryCi: { readonly endpoint: string; readonly serviceId: "ordinary-main"; readonly credential: Credential };
  readonly nativeGit: { readonly endpoint: string; readonly serviceId: "native-main" };
};

export interface NativeRootCiHostClient {
  readonly hostId: string;
  readonly capacity: string;
  attest(signal: AbortSignal): Promise<void>;
  prepareClaim(requestId: string): NativeRootCiHostPreparedRequest;
  reserve(request: NativeRootCiHostPreparedRequest, signal: AbortSignal): Promise<NativeRootCiClaim | undefined>;
  issue(claim: NativeRootCiClaim, signal: AbortSignal): Promise<NativeJobAttemptIssuance>;
  prepareActivation(claim: NativeRootCiClaim, issuance: NativeJobAttemptIssuance, requestId: string): NativeRootCiHostPreparedRequest;
  activate(request: NativeRootCiHostPreparedRequest, signal: AbortSignal): Promise<NativeRootCiActiveClaim>;
  prepareRenewal(active: NativeRootCiActiveClaim, requestId: string): NativeRootCiHostPreparedRequest;
  renew(request: NativeRootCiHostPreparedRequest, signal: AbortSignal): Promise<NativeRootCiActiveClaim>;
  prepareRecovery(claim: NativeRootCiClaim, issuance: NativeJobAttemptIssuance, requestId: string): NativeRootCiHostPreparedRequest;
  recover(request: NativeRootCiHostPreparedRequest, signal: AbortSignal): Promise<void>;
  prepareResult(request: NativeRootCiHostResultRequest): NativeRootCiHostPreparedRequest;
  report(request: NativeRootCiHostPreparedRequest, signal: AbortSignal): Promise<void>;
  candidateLease(active: NativeRootCiActiveClaim, requestId: string, signal: AbortSignal): Promise<NativeCandidateLease>;
}

export function createNativeRootCiHostClient(
  config: NativeRootCiHostClientConfig,
  httpClient: NativeGitAdmissionHttpClient = createNodeNativeGitAdmissionHttpClient()
): NativeRootCiHostClient {
  const authorization = basic(config.ordinaryCi.credential);
  return {
    hostId: config.hostId,
    capacity: config.capacity,
    async attest(signal) {
      const value = exactRecord(await sendGet(httpClient, config.ordinaryCi.endpoint, authorization,
        "/v1/host-identity", signal), ["schemaVersion", "serviceId", "role", "hostId"]);
      if (value.schemaVersion !== 1 || value.serviceId !== config.ordinaryCi.serviceId
        || value.role !== "native-host" || value.hostId !== config.hostId) mismatch();
    },
    prepareClaim(requestId) {
      return prepared(parseNativeRootCiClaimRequest({ schemaVersion: 1, requestId,
        generationId: config.generationId, hostId: config.hostId, capacity: config.capacity }));
    },
    async reserve(request, signal) {
      const trusted = parsePrepared(request, parseNativeRootCiClaimRequest);
      assertScope(config, trusted);
      const response = await sendJson(httpClient, config.ordinaryCi.endpoint, authorization,
        "/v1/host-claims", request.body, signal, [200, 201, 204]);
      if (response.statusCode === 204) return undefined;
      const claim = parseNativeRootCiClaim(response.body);
      if (claim.requestId !== trusted.requestId || claim.serviceId !== config.ordinaryCi.serviceId
        || claim.generationId !== config.generationId || claim.hostId !== config.hostId
        || claim.capacity !== config.capacity) mismatch();
      return claim;
    },
    async issue(claim, signal) {
      assertScope(config, claim);
      const requestId = claim.issuanceRequestId;
      const response = await sendJson(httpClient, config.ordinaryCi.endpoint, authorization,
        "/v1/host-attempts", JSON.stringify({ schemaVersion: 1, requestId, claim }), signal, [201]);
      const body = exactRecord(response.body, ["schemaVersion", "serviceId", "requestId", "issuance"]);
      if (body.schemaVersion !== 1 || body.serviceId !== config.ordinaryCi.serviceId || body.requestId !== requestId) mismatch();
      return parseNativeJobAttemptIssuance(body.issuance);
    },
    prepareActivation(claim, issuance, requestId) {
      return prepared(parseNativeRootCiClaimActivationRequest({ schemaVersion: 1, requestId,
        generationId: config.generationId, claim, issuance }));
    },
    async activate(request, signal) {
      const trusted = parsePrepared(request, parseNativeRootCiClaimActivationRequest);
      const response = await sendJson(httpClient, config.ordinaryCi.endpoint, authorization,
        "/v1/host-claim-activations", request.body, signal, [200, 201]);
      const active = parseNativeRootCiActiveClaim(response.body);
      if (active.serviceId !== config.ordinaryCi.serviceId || active.generationId !== config.generationId
        || active.serviceEpochId !== trusted.claim.serviceEpochId || active.requestId !== trusted.requestId
        || active.claimId !== trusted.claim.claimId || !isDeepStrictEqual(active.issuance, trusted.issuance)
        || !isDeepStrictEqual(active.assignment, nativeRootCiAttemptAssignment(trusted.claim, trusted.issuance))) mismatch();
      return active;
    },
    prepareRenewal(active, requestId) {
      return prepared(parseNativeRootCiClaimLeaseRequest(leaseRequest(config, active, requestId)));
    },
    async renew(request, signal) {
      const trusted = parsePrepared(request, parseNativeRootCiClaimLeaseRequest);
      const response = await sendJson(httpClient, config.ordinaryCi.endpoint, authorization,
        "/v1/host-claim-renewals", request.body, signal, [200]);
      const active = parseNativeRootCiActiveClaim(response.body);
      if (active.serviceId !== config.ordinaryCi.serviceId || active.generationId !== trusted.generationId
        || active.requestId !== trusted.requestId || active.claimId !== trusted.claimId
        || active.assignment.attemptId !== trusted.attemptId
        || active.assignment.descriptorDigest !== trusted.descriptorDigest
        || active.assignment.hostId !== trusted.hostId || active.assignment.capacity !== trusted.capacity
        || active.issuance.attemptId !== trusted.attemptId
        || active.issuance.descriptorDigest !== trusted.descriptorDigest
        || active.issuance.hostId !== trusted.hostId || active.issuance.capacity !== trusted.capacity) mismatch();
      return active;
    },
    async candidateLease(active, requestId, signal) {
      const response = await sendJson(httpClient, config.ordinaryCi.endpoint, authorization,
        "/v1/host-candidate-leases", JSON.stringify({ schemaVersion: 1, requestId, claimId: active.claimId,
          attemptId: active.issuance.attemptId, descriptorDigest: active.issuance.descriptorDigest }), signal, [201]);
      const body = exactRecord(response.body,
        ["schemaVersion", "serviceId", "requestId", "username", "password", "expiresAt"]);
      if (body.schemaVersion !== 1 || body.serviceId !== config.ordinaryCi.serviceId || body.requestId !== requestId
        || typeof body.username !== "string" || typeof body.password !== "string"
        || typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt)) mismatch();
      return { username: body.username, password: body.password, expiresAt: body.expiresAt };
    },
    prepareRecovery(claim, issuance, requestId) {
      return prepared(parseNativeRootCiClaimRecoveryRequest({ schemaVersion: 1, requestId,
        generationId: config.generationId, hostId: config.hostId, capacity: config.capacity,
        claimId: claim.claimId, attemptId: issuance.attemptId, descriptorDigest: issuance.descriptorDigest,
        claim, issuance, resourceId: claim.claimId, cleanupComplete: true }));
    },
    async recover(request, signal) {
      parsePrepared(request, parseNativeRootCiClaimRecoveryRequest);
      await sendEmpty(httpClient, config.ordinaryCi.endpoint, authorization,
        "/v1/host-recoveries", request.body, signal);
    },
    prepareResult(request) { return prepared(parseNativeRootCiHostResultRequest(request)); },
    async report(request, signal) {
      const trusted = parsePrepared(request, parseNativeRootCiHostResultRequest);
      const response = await sendJson(httpClient, config.ordinaryCi.endpoint, authorization,
        "/v1/host-results", request.body, signal, [202]);
      const acknowledgement = exactRecord(response.body, ["schemaVersion", "claimId", "accepted"]);
      if (acknowledgement.schemaVersion !== 1 || acknowledgement.claimId !== trusted.claimId
        || acknowledgement.accepted !== true) mismatch();
    },
  };
}

function leaseRequest(config: NativeRootCiHostClientConfig, active: NativeRootCiActiveClaim,
  requestId: string): NativeRootCiClaimLeaseRequest {
  return { schemaVersion: 1, requestId, generationId: config.generationId, hostId: config.hostId,
    capacity: config.capacity, claimId: active.claimId, attemptId: active.issuance.attemptId,
    descriptorDigest: active.issuance.descriptorDigest };
}

function assertScope(config: NativeRootCiHostClientConfig, request: NativeRootCiClaimRequest): void {
  if (request.generationId !== config.generationId || request.hostId !== config.hostId
    || request.capacity !== config.capacity) mismatch();
}

function basic(credential: Credential): string {
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`;
}

function mismatch(): never {
  throw new NativeRootCiHostClientError("native root CI response or prepared request is inconsistent");
}

export const nativeRootCiHostRandomRequestId = randomUUID;
