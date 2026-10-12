import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { UserError } from "./errors.js";
import {
  NativeGitAttemptIssuerRejectedError,
  NativeGitAttemptIssuerUnavailableError,
  type NativeGitAttemptIssuerClient
} from "./nativeGitAttemptIssuerClient.js";
import { NativeAdmissionSourceRejectedError, NativeAdmissionSourceUnavailableError } from "./nativeGitAdmissionSource.js";
import type { NativeGitCurrentAttemptProofClient } from "./nativeGitCurrentAttemptProofClient.js";
import { requestNativeGitCandidateLease } from "./nativeGitCandidateLeaseClient.js";
import type { NativeGitAdmissionHttpClient } from "./nativeGitAdmissionSource.js";
import type { NativeCapacityPolicy } from "./nativeOrdinaryAuthorityModel.js";
import type { NativeOrdinaryAuthorityConfig, NativeOrdinaryCredential } from "./nativeOrdinaryAuthorityConfig.js";
import {
  nativeRootCiAttemptAssignment,
  parseNativeRootCiClaimActivationRequest,
  parseNativeRootCiClaimLeaseRequest,
  parseNativeRootCiClaimRecoveryRequest
} from "./nativeRootCiClaimLifecycleProtocol.js";
import type { NativeRootCiClaimLifecycleStore } from "./nativeRootCiClaimLifecycleStore.js";
import { readNativeRootCiCandidateAssignment } from "./nativeRootCiCandidateAssignment.js";
import { parseNativeRootCiClaim, type NativeRootCiClaim } from "./nativeRootCiClaimProtocol.js";

const maximumBodyBytes = 64 * 1024;
const lifecyclePaths = new Set(["/v1/host-attempts", "/v1/host-claim-activations",
  "/v1/host-claim-renewals", "/v1/host-candidate-leases", "/v1/host-recoveries"]);

type LifecycleHttpOptions = {
  readonly config: NativeOrdinaryAuthorityConfig;
  readonly generationId: string;
  readonly capacities: ReadonlyMap<string, NativeCapacityPolicy>;
  readonly store: NativeRootCiClaimLifecycleStore;
  readonly proof: NativeGitCurrentAttemptProofClient;
  readonly issuer: NativeGitAttemptIssuerClient;
  readonly httpClient: NativeGitAdmissionHttpClient;
  readonly claimCurrent: (claim: NativeRootCiClaim) => boolean;
  readonly active: () => boolean;
};

export function createNativeRootCiClaimLifecycleHandler(options: LifecycleHttpOptions) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (url.search !== "" || request.method !== "POST" || !lifecyclePaths.has(url.pathname)) return false;
    const hostId = authenticatedHost(request, options.config);
    if (hostId === undefined) return authenticationFailure(request, response, options.config);
    if (!options.active()) return sendJson(response, 503,
      { error: "native root CI claim lifecycle requires exact generation activation" });
    try {
      if (url.pathname === "/v1/host-attempts") {
        const body = exactRecord(await readJson(request), ["schemaVersion", "requestId", "claim"]);
        const claim = parseNativeRootCiClaim(body.claim);
        if (body.schemaVersion !== 1 || body.requestId !== claim.issuanceRequestId
          || !inScope(options, hostId, claim.hostId, claim.capacity) || !options.claimCurrent(claim)) {
          return notFound(response);
        }
        const descriptor = await options.issuer.loadDescriptor({ claim });
        const issued = await options.issuer.issueAttempt({ context: { claim }, descriptor });
        return sendJson(response, 201, { schemaVersion: 1, serviceId: options.config.serviceId,
          requestId: body.requestId, issuance: issued.issuance });
      }
      if (url.pathname === "/v1/host-claim-activations") {
        const input = parseNativeRootCiClaimActivationRequest(await readJson(request));
        if (!inScope(options, hostId, input.claim.hostId, input.claim.capacity)) return notFound(response);
        if (input.generationId !== options.generationId || input.claim.generationId !== options.generationId) {
          return sendJson(response, 409, { error: "native root CI claim activation generation is stale" });
        }
        const replay = options.store.activationReplay(input);
        if (replay.kind === "replay") return sendJson(response, 200, replay.response);
        if (replay.kind === "conflict") return conflict(response, "native root CI claim activation conflicts");
        if (!options.store.activationEligible(input)) return conflict(response, "native root CI claim activation conflicts");
        const assignment = attemptAssignment(input.claim, input.issuance);
        if (assignment === undefined) return conflict(response, "native root CI attempt assignment conflicts");
        const proven = await options.proof.assertCurrent(input.issuance);
        if (!isDeepStrictEqual(proven, input.issuance)) return conflict(response, "native root CI attempt proof conflicts");
        const activated = options.store.activate(input, assignment);
        return activated.kind === "created" ? sendJson(response, 201, activated.response)
          : conflict(response, "native root CI claim activation conflicts");
      }
      if (url.pathname === "/v1/host-claim-renewals") {
        const input = parseNativeRootCiClaimLeaseRequest(await readJson(request));
        if (!inScope(options, hostId, input.hostId, input.capacity)) return notFound(response);
        if (input.generationId !== options.generationId) {
          return sendJson(response, 409, { error: "native root CI claim renewal generation is stale" });
        }
        const renewed = options.store.renew(input);
        return renewed === undefined ? conflict(response, "native root CI claim renewal conflicts")
          : sendJson(response, 200, renewed);
      }
      if (url.pathname === "/v1/host-candidate-leases") {
        const body = exactRecord(await readJson(request),
          ["schemaVersion", "requestId", "claimId", "attemptId", "descriptorDigest"]);
        if (body.schemaVersion !== 1 || !uuid(body.requestId) || !uuid(body.claimId)
          || !uuid(body.attemptId) || typeof body.descriptorDigest !== "string"
          || !/^sha256:[0-9a-f]{64}$/.test(body.descriptorDigest)) {
          throw new LifecycleHttpError(400, "native root CI candidate lease request is invalid");
        }
        const assignment = readNativeRootCiCandidateAssignment({ database: options.store.database,
          serviceEpochId: options.store.context.serviceEpochId, generationId: options.store.context.generationId,
          now: options.store.context.now(), claimId: body.claimId, hostId,
          attemptId: body.attemptId, descriptorDigest: body.descriptorDigest });
        if (assignment === undefined) return notFound(response);
        const lease = await requestNativeGitCandidateLease({ endpoint: options.config.nativeGit.endpoint,
          credential: options.config.nativeGit.candidateReader, httpClient: options.httpClient,
          signal: AbortSignal.timeout(5_000), selector: { schemaVersion: 1, requestId: body.requestId,
            executionKind: "ordinary-sysbox", projectId: assignment.descriptor.projectId,
            reviewId: assignment.reviewId, jobName: assignment.descriptor.jobName,
            attemptId: assignment.attemptId, descriptorDigest: assignment.descriptorDigest,
            hostId: assignment.hostId, capacity: assignment.capacity } });
        return sendJson(response, 201, { schemaVersion: 1, serviceId: options.config.serviceId,
          requestId: body.requestId, ...lease });
      }
      const input = parseNativeRootCiClaimRecoveryRequest(await readJson(request));
      if (!inScope(options, hostId, input.hostId, input.capacity)) return notFound(response);
      if (input.generationId !== options.generationId) {
        return sendJson(response, 409, { error: "native root CI claim recovery generation is stale" });
      }
      const replay = options.store.recoveryReplay(input);
      if (replay.kind === "released") return empty(response);
      if (replay.kind === "conflict") return conflict(response, "native root CI claim recovery conflicts");
      if (!options.store.recoveryEligible(input)) return conflict(response, "native root CI claim recovery conflicts");
      const assignment = attemptAssignment(input.claim, input.issuance);
      if (assignment === undefined) return conflict(response, "native root CI attempt assignment conflicts");
      if (replay.kind === "none") {
        const proven = await options.proof.assertCurrent(input.issuance);
        if (!isDeepStrictEqual(proven, input.issuance)) return conflict(response, "native root CI attempt proof conflicts");
        const prepared = options.store.prepareRecovery(input, assignment);
        if (prepared.kind === "released") return empty(response);
        if (prepared.kind === "conflict") return conflict(response, "native root CI claim recovery conflicts");
      }
      const revocation = await options.issuer.revokeAttempt(input.issuance);
      return options.store.completeRecovery(input, revocation) ? empty(response)
        : conflict(response, "native root CI claim recovery conflicts");
    } catch (error) {
      if (error instanceof NativeAdmissionSourceRejectedError || error instanceof NativeGitAttemptIssuerRejectedError) {
        return conflict(response, "native root CI claim lifecycle conflicts with native authority");
      }
      if (error instanceof NativeAdmissionSourceUnavailableError || error instanceof NativeGitAttemptIssuerUnavailableError) {
        return sendJson(response, 503, { error: error.message });
      }
      if (error instanceof LifecycleHttpError) return sendJson(response, error.status, { error: error.message });
      if (error instanceof UserError) return sendJson(response, 400, { error: error.message });
      throw error;
    }
  };
}

function attemptAssignment(
  claim: Parameters<typeof nativeRootCiAttemptAssignment>[0],
  issuance: Parameters<typeof nativeRootCiAttemptAssignment>[1]
): ReturnType<typeof nativeRootCiAttemptAssignment> | undefined {
  try { return nativeRootCiAttemptAssignment(claim, issuance); }
  catch (error) {
    if (error instanceof UserError) return undefined;
    throw error;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") {
    throw new LifecycleHttpError(415, "content type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBodyBytes) throw new LifecycleHttpError(413, "request body is too large");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new LifecycleHttpError(400, "request body must be valid JSON");
    throw error;
  }
}
function inScope(options: LifecycleHttpOptions, authenticated: string, requested: string, capacity: string): boolean {
  return authenticated === requested && options.capacities.has(`${authenticated}\0${capacity}`);
}
function authenticatedHost(request: IncomingMessage, config: NativeOrdinaryAuthorityConfig): string | undefined {
  return config.hosts.find((host) => authorized(request, { username: host.hostId, password: host.hostToken }))?.hostId;
}
function authenticationFailure(request: IncomingMessage, response: ServerResponse,
  config: NativeOrdinaryAuthorityConfig): true {
  return knownCredentials(config).some((credential) => authorized(request, credential))
    ? sendJson(response, 403, { error: "forbidden" }) : sendJson(response, 401, { error: "unauthorized" });
}
function knownCredentials(config: NativeOrdinaryAuthorityConfig): readonly NativeOrdinaryCredential[] {
  return [...Object.values(config.credentials), config.nativeGit.identity, config.nativeGit.attemptIssuer,
    config.nativeGit.candidateReader, config.nativeGit.resultReporter,
    ...config.hosts.map((host) => ({ username: host.hostId, password: host.hostToken }))];
}
function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new LifecycleHttpError(400, "native root CI lifecycle request fields are invalid");
  }
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)]));
}
function uuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
function authorized(request: IncomingMessage, credential: NativeOrdinaryCredential): boolean {
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function sendJson(response: ServerResponse, status: number, body: unknown): true {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
  return true;
}
function conflict(response: ServerResponse, error: string): true { return sendJson(response, 409, { error }); }
function empty(response: ServerResponse): true {
  response.writeHead(204, { "cache-control": "no-store" }).end();
  return true;
}
function notFound(response: ServerResponse): true { return sendJson(response, 404, { error: "not found" }); }
class LifecycleHttpError extends Error {
  readonly name = "LifecycleHttpError";
  constructor(readonly status: 400 | 413 | 415, message: string) { super(message); }
}
