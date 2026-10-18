import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NativeCapacityPolicy } from "./nativeOrdinaryAuthorityModel.js";
import type { NativeOrdinaryAuthorityConfig, NativeOrdinaryCredential } from "./nativeOrdinaryAuthorityConfig.js";
import {
  parseNativeRootCiClaimRequest,
  parseNativeRootCiClaimVerificationRequest
} from "./nativeRootCiClaimProtocol.js";
import {
  NativeRootCiClaimStore,
  NativeRootCiStaleEpochError
} from "./nativeRootCiClaimStore.js";

const maximumBodyBytes = 64 * 1024;

type ClaimHttpOptions = {
  readonly config: NativeOrdinaryAuthorityConfig;
  readonly generationId: string;
  readonly serviceEpochId: string;
  readonly capacities: ReadonlyMap<string, NativeCapacityPolicy>;
  readonly store: NativeRootCiClaimStore;
  readonly active: () => boolean;
};

export function createNativeRootCiClaimHandler(options: ClaimHttpOptions) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (url.search !== "") return false;
    if (request.method === "GET" && url.pathname === "/v1/host-identity") {
      const hostId = authenticatedHost(request, options.config);
      if (hostId === undefined) return authenticationFailure(request, response, options.config);
      return sendJson(response, 200, {
        schemaVersion: 1,
        serviceId: options.config.serviceId,
        role: "native-host",
        hostId
      });
    }
    if (url.pathname === "/v1/host-claims") {
      if (request.method !== "POST") return notFound(response);
      const hostId = authenticatedHost(request, options.config);
      if (hostId === undefined) return authenticationFailure(request, response, options.config);
      if (!options.active()) return sendJson(response, 503,
        { error: "native root CI claim reservation requires exact generation activation" });
      try {
        const input = parseNativeRootCiClaimRequest(await readJson(request));
        if (input.generationId !== options.generationId) {
          return sendJson(response, 409, { error: "native root CI claim generation is stale" });
        }
        if (input.hostId !== hostId || !options.capacities.has(`${hostId}\0${input.capacity}`)) return notFound(response);
        const result = options.store.reserve(input);
        switch (result.kind) {
          case "created": return sendJson(response, 201, result.claim);
          case "replay": return sendJson(response, 200, result.claim);
          case "empty": return empty(response);
          case "conflict": return sendJson(response, 409, { error: "native root CI claim reservation conflicts" });
          default: return assertNever(result);
        }
      } catch (error) {
        if (error instanceof ClaimHttpError) return sendJson(response, error.status, { error: error.message });
        if (error instanceof NativeRootCiStaleEpochError) return sendJson(response, 503, { error: error.message });
        throw error;
      }
    }
    if (url.pathname !== "/v1/claim-reservation-verifications") return false;
    if (request.method !== "POST") return notFound(response);
    if (!authorized(request, options.config.credentials.query)) {
      return authenticationFailure(request, response, options.config);
    }
    if (!options.active()) return sendJson(response, 503,
      { error: "native root CI claim verification requires exact generation activation" });
    try {
      const input = parseNativeRootCiClaimVerificationRequest(await readJson(request));
      if (input.generationId !== options.generationId || input.claim.generationId !== options.generationId) {
        return sendJson(response, 409, { error: "native root CI claim generation is stale" });
      }
      if (input.claim.serviceId !== options.config.serviceId) return notFound(response);
      const result = options.store.verify(input.claim);
      if (result === "not-found") return notFound(response);
      if (result === "stale") return sendJson(response, 409, { error: "native root CI claim service epoch is stale" });
      return sendJson(response, 200, { schemaVersion: 1, serviceId: options.config.serviceId,
        requestId: input.requestId, claimId: input.claim.claimId,
        issuanceRequestId: input.claim.issuanceRequestId, authorized: true });
    } catch (error) {
      if (error instanceof ClaimHttpError) return sendJson(response, error.status, { error: error.message });
      throw error;
    }
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") {
    throw new ClaimHttpError(415, "content type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBodyBytes) throw new ClaimHttpError(413, "request body is too large");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new ClaimHttpError(400, "request body must be valid JSON");
    throw error;
  }
}

function authenticatedHost(request: IncomingMessage, config: NativeOrdinaryAuthorityConfig): string | undefined {
  return config.hosts.find((host) => authorized(request, { username: host.hostId, password: host.hostToken }))?.hostId;
}
function authenticationFailure(request: IncomingMessage, response: ServerResponse,
  config: NativeOrdinaryAuthorityConfig): true {
  return knownCredentials(config).some((credential) => authorized(request, credential))
    ? sendJson(response, 403, { error: "forbidden" })
    : sendJson(response, 401, { error: "unauthorized" });
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
function empty(response: ServerResponse): true {
  response.writeHead(204, { "cache-control": "no-store" }).end();
  return true;
}
function notFound(response: ServerResponse): true { return sendJson(response, 404, { error: "not found" }); }
function assertNever(value: never): never { throw new TypeError(`unexpected claim reservation result: ${JSON.stringify(value)}`); }
class ClaimHttpError extends Error {
  readonly name = "ClaimHttpError";
  constructor(readonly status: 400 | 413 | 415, message: string) { super(message); }
}
