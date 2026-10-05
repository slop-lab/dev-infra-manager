import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpRequest,
  NativeGitAdmissionHttpResponse
} from "./nativeGitAdmissionSource.js";
import type {
  NativeHostClaim,
  NativeHostClaimRequest,
  NativeHostClaimRenewal,
  NativeHostClaimRenewalRequest,
  NativeHostRecoveryRequest
} from "./nativeOrdinaryClaimProtocol.js";
import {
  parseNativeHostClaimRequest,
  parseNativeHostRecoveryRequest as parseNativeHostRecoveryBody
} from "./nativeOrdinaryClaimProtocol.js";
import { parseNativeHostResultRequest, type NativeHostResultRequest } from "./nativeOrdinaryResultProtocol.js";
import type { NativeHostPreparedRequest } from "./nativeOrdinaryHostJournal.js";
import {
  exactNativeHostResponse,
  NativeOrdinaryHostClientError,
  nativeHostIdentifier,
  nativeHostUuid,
  parseNativeHostClaimResponse,
  parseNativeHostRecoveryRequest,
  parseNativeHostRenewalRequest,
  parseNativeHostRenewalResponse
} from "./nativeOrdinaryHostClientProtocol.js";
export { NativeOrdinaryHostClientError } from "./nativeOrdinaryHostClientProtocol.js";
import { createNodeNativeOrdinaryHostHttpClient } from "./nativeOrdinaryHostTransport.js";

const requestTimeoutMilliseconds = 5_000;
const maximumResponseBytes = 64 * 1024;

export type NativeOrdinaryHostClientConfig = {
  readonly endpoint: string;
  readonly serviceId: string;
  readonly hostId: string;
  readonly capacity: string;
  readonly credential: {
    readonly username: string;
    readonly password: string;
  };
};

export interface NativeOrdinaryHostClient {
  readonly hostId: string;
  readonly capacity: string;
  attest(signal: AbortSignal): Promise<void>;
  prepareClaim(requestId: string): NativeHostPreparedRequest;
  claim(request: NativeHostPreparedRequest, signal: AbortSignal): Promise<NativeHostClaim | undefined>;
  renewClaim(request: NativeHostClaimRenewalRequest, signal: AbortSignal): Promise<NativeHostClaimRenewal>;
  prepareRecovery(request: NativeHostRecoveryRequest): NativeHostPreparedRequest;
  recoverClaim(request: NativeHostPreparedRequest, signal: AbortSignal): Promise<void>;
  prepareResult(request: NativeHostResultRequest): NativeHostPreparedRequest;
  reportResult(request: NativeHostPreparedRequest, signal: AbortSignal): Promise<void>;
}

export function createNodeNativeOrdinaryHostClient(
  config: NativeOrdinaryHostClientConfig
): NativeOrdinaryHostClient {
  return createNativeOrdinaryHostClient(config, createNodeNativeOrdinaryHostHttpClient());
}

export function createNativeOrdinaryHostClient(
  config: NativeOrdinaryHostClientConfig,
  httpClient: NativeGitAdmissionHttpClient
): NativeOrdinaryHostClient {
  const endpoint = parseEndpoint(config.endpoint);
  const serviceId = nativeHostIdentifier(config.serviceId, "service ID");
  const hostId = nativeHostIdentifier(config.hostId, "host ID");
  const capacity = nativeHostIdentifier(config.capacity, "capacity");
  const username = nativeHostIdentifier(config.credential.username, "host username");
  const password = hostPassword(config.credential.password);
  if (username !== hostId) throw new NativeOrdinaryHostClientError("host credential username must equal host ID");
  const authorization = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;

  return {
    hostId,
    capacity,
    async attest(signal) {
      const body = await jsonRequest(httpClient, request({
        endpoint, authorization, method: "GET", path: "/v1/host-identity", signal
      }), 200);
      const identity = exactNativeHostResponse(body, ["schemaVersion", "serviceId", "role", "hostId"]);
      if (identity.schemaVersion !== 1 || identity.serviceId !== serviceId
        || identity.role !== "native-host" || identity.hostId !== hostId) {
        throw new NativeOrdinaryHostClientError("native ordinary host identity does not match configuration");
      }
    },
    prepareClaim(requestId) {
      const validRequestId = nativeHostUuid(requestId, "request ID");
      return prepared({ schemaVersion: 1, requestId: validRequestId, hostId, capacity });
    },
    async claim(preparedRequest, signal) {
      const requestedAt = Date.now();
      const trusted = parsePrepared(preparedRequest, parseNativeHostClaimRequest);
      if (trusted.hostId !== hostId || trusted.capacity !== capacity) {
        throw new NativeOrdinaryHostClientError("native ordinary claim is outside configured capacity");
      }
      const response = await rawRequest(httpClient, request({
        endpoint, authorization, method: "POST", path: "/v1/host-claims", signal,
        body: preparedRequest.body
      }));
      if (response.statusCode === 204) {
        assertEmpty(response);
        return undefined;
      }
      if (response.statusCode !== 200) throw new NativeOrdinaryHostRequestRejectedError(response.statusCode);
      const claim = parseNativeHostClaimResponse(parseJsonResponse(response, 200));
      if (claim.serviceId !== serviceId || claim.requestId !== trusted.requestId || claim.hostId !== hostId
        || claim.capacity !== capacity || claim.leaseExpiresAt <= requestedAt) {
        throw new NativeOrdinaryHostClientError("native ordinary claim does not match the request");
      }
      return claim;
    },
    async renewClaim(input, signal) {
      const trusted = parseNativeHostRenewalRequest(input, hostId, capacity);
      const body = await jsonRequest(httpClient, request({
        endpoint, authorization, method: "POST", path: "/v1/host-claim-renewals", signal,
        body: JSON.stringify(trusted)
      }), 200);
      const renewal = parseNativeHostRenewalResponse(body);
      if (renewal.serviceId !== serviceId || renewal.requestId !== trusted.requestId
        || renewal.claimId !== trusted.claimId) {
        throw new NativeOrdinaryHostClientError("native ordinary renewal does not match the request");
      }
      return renewal;
    },
    prepareRecovery(input) {
      return prepared(parseNativeHostRecoveryRequest(input, hostId, capacity));
    },
    async recoverClaim(input, signal) {
      const trusted = parsePrepared(input, (value) => parseNativeHostRecoveryRequest(
        parseNativeHostRecoveryBody(value), hostId, capacity
      ));
      const response = await rawRequest(httpClient, request({
        endpoint, authorization, method: "POST", path: "/v1/host-recoveries", signal, body: input.body
      }));
      if (response.statusCode !== 204) throw new NativeOrdinaryHostRequestRejectedError(response.statusCode);
      assertEmpty(response);
    },
    prepareResult(input) {
      return prepared(parseNativeHostResultRequest(input));
    },
    async reportResult(input, signal) {
      const trusted = parsePrepared(input, parseNativeHostResultRequest);
      const body = await jsonRequest(httpClient, request({
        endpoint, authorization, method: "POST", path: "/v1/host-results", signal, body: input.body
      }), 202);
      const acknowledgement = exactNativeHostResponse(body, ["schemaVersion", "claimId", "accepted"]);
      if (acknowledgement.schemaVersion !== 1 || acknowledgement.claimId !== trusted.claimId
        || acknowledgement.accepted !== true) {
        throw new NativeOrdinaryHostClientError("native ordinary result acknowledgement does not match the request");
      }
    }
  };
}

type HostRequest = {
  readonly endpoint: string;
  readonly authorization: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly signal: AbortSignal;
  readonly body?: string;
};

function request(input: HostRequest): NativeGitAdmissionHttpRequest {
  return {
    endpoint: input.endpoint,
    method: input.method,
    path: input.path,
    authorization: input.authorization,
    ...(input.body === undefined ? {} : { body: input.body }),
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(requestTimeoutMilliseconds)])
  };
}

function prepared(request: NativeHostClaimRequest | NativeHostRecoveryRequest | NativeHostResultRequest): NativeHostPreparedRequest {
  return { requestId: request.requestId, body: JSON.stringify(request) };
}

function parsePrepared<T>(request: NativeHostPreparedRequest, parser: (value: unknown) => T): T {
  let value: unknown;
  try {
    value = JSON.parse(request.body);
  } catch (error) {
    if (error instanceof SyntaxError) throw new NativeOrdinaryHostClientError("prepared native host request is not JSON", { cause: error });
    throw error;
  }
  const parsed = parser(value);
  if (typeof parsed !== "object" || parsed === null || Reflect.get(parsed, "requestId") !== request.requestId) {
    throw new NativeOrdinaryHostClientError("prepared native host request ID is inconsistent");
  }
  return parsed;
}

async function jsonRequest(
  client: NativeGitAdmissionHttpClient,
  input: NativeGitAdmissionHttpRequest,
  expectedStatus: number
): Promise<unknown> {
  return parseJsonResponse(await rawRequest(client, input), expectedStatus);
}

async function rawRequest(
  client: NativeGitAdmissionHttpClient,
  input: NativeGitAdmissionHttpRequest
): Promise<NativeGitAdmissionHttpResponse> {
  try {
    return await client.request(input);
  } catch (error) {
    throw new NativeOrdinaryHostClientError("native ordinary host request failed", { cause: error });
  }
}

function parseJsonResponse(response: NativeGitAdmissionHttpResponse, expectedStatus: number): unknown {
  if (response.statusCode !== expectedStatus) throw new NativeOrdinaryHostRequestRejectedError(response.statusCode);
  if (response.contentType !== "application/json"
    || response.cacheControl !== "no-store" || response.body.length > maximumResponseBytes) {
    throw new NativeOrdinaryHostClientError("native ordinary host response contract is invalid");
  }
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new NativeOrdinaryHostClientError("native ordinary host response is not JSON", { cause: error });
    throw error;
  }
}

export class NativeOrdinaryHostRequestRejectedError extends NativeOrdinaryHostClientError {
  override readonly name: string = "NativeOrdinaryHostRequestRejectedError";

  constructor(readonly statusCode: number) {
    super(`native ordinary host request was rejected with HTTP ${statusCode}`);
  }
}

function assertEmpty(response: NativeGitAdmissionHttpResponse): void {
  if (response.cacheControl !== "no-store" || response.contentType !== undefined || response.body.length !== 0) {
    throw new NativeOrdinaryHostClientError("native ordinary empty acknowledgement is invalid");
  }
}

function parseEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) throw new NativeOrdinaryHostClientError("native ordinary endpoint is invalid", { cause: error });
    throw error;
  }
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || endpoint.username !== ""
    || endpoint.password !== "" || endpoint.pathname !== "/" || endpoint.search !== "" || endpoint.hash !== "") {
    throw new NativeOrdinaryHostClientError("native ordinary endpoint must be an HTTP origin without credentials");
  }
  return endpoint.origin;
}

function hostPassword(value: string): string {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(value)) throw new NativeOrdinaryHostClientError("host password is invalid");
  return value;
}
