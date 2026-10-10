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
import type { NativeCapacityPolicy } from "./nativeOrdinaryAuthorityModel.js";
import type { NativeOrdinaryAuthorityConfig, NativeOrdinaryCredential } from "./nativeOrdinaryAuthorityConfig.js";
import {
  nativeRootCiAttemptAssignment,
  parseNativeRootCiClaimActivationRequest,
  parseNativeRootCiClaimLeaseRequest,
  parseNativeRootCiClaimRecoveryRequest
} from "./nativeRootCiClaimLifecycleProtocol.js";
import type { NativeRootCiClaimLifecycleStore } from "./nativeRootCiClaimLifecycleStore.js";

const maximumBodyBytes = 64 * 1024;
const lifecyclePaths = new Set(["/v1/host-claim-activations", "/v1/host-claim-renewals", "/v1/host-recoveries"]);

type LifecycleHttpOptions = {
  readonly config: NativeOrdinaryAuthorityConfig;
  readonly generationId: string;
  readonly capacities: ReadonlyMap<string, NativeCapacityPolicy>;
  readonly store: NativeRootCiClaimLifecycleStore;
  readonly proof: NativeGitCurrentAttemptProofClient;
  readonly issuer: NativeGitAttemptIssuerClient;
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
    config.nativeGit.resultReporter,
    ...config.hosts.map((host) => ({ username: host.hostId, password: host.hostToken }))];
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
