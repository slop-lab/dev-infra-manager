import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NativeOrdinaryClaimService } from "./nativeOrdinaryClaimService.js";
import type { NativeCapacityPolicy } from "./nativeOrdinaryAuthorityModel.js";
import type {
  NativeOrdinaryAuthorityConfig,
  NativeOrdinaryCredential
} from "./nativeOrdinaryAuthorityConfig.js";
import type { NativeOrdinaryLeaseService } from "./nativeOrdinaryLeaseService.js";
import {
  parseNativeHostClaimRenewalRequest,
  parseNativeHostClaimRequest,
  parseNativeHostRecoveryRequest
} from "./nativeOrdinaryClaimProtocol.js";
import { parseNativeHostResultRequest } from "./nativeOrdinaryResultProtocol.js";
import type { NativeOrdinaryAuthorityStore } from "./nativeOrdinaryAuthorityStore.js";

type HostHttpContext = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly pathname: string;
  readonly config: NativeOrdinaryAuthorityConfig;
  readonly capacities: ReadonlyMap<string, NativeCapacityPolicy>;
  readonly claimService: NativeOrdinaryClaimService;
  readonly leaseService: NativeOrdinaryLeaseService;
  readonly store: NativeOrdinaryAuthorityStore;
  readonly readJson: () => Promise<unknown>;
};

export async function handleNativeOrdinaryHostHttp(context: HostHttpContext): Promise<boolean> {
  const identityRequest = context.request.method === "GET" && context.pathname === "/v1/host-identity";
  if (!identityRequest && (context.request.method !== "POST" || !hostPaths.has(context.pathname))) return false;
  const hostId = authenticatedHost(context.request, context.config);
  if (hostId === undefined) {
    const recognized = knownCredential(context.request, context.config);
    sendJson(context.response, recognized ? 403 : 401, {
      error: recognized ? "forbidden" : "unauthorized"
    });
    return true;
  }
  if (identityRequest) {
    sendJson(context.response, 200, {
      schemaVersion: 1,
      serviceId: context.config.serviceId,
      role: "native-host",
      hostId
    });
    return true;
  }
  if (context.pathname === "/v1/host-claims") {
    const claimRequest = parseNativeHostClaimRequest(await context.readJson());
    if (!inScope(context, hostId, claimRequest.hostId, claimRequest.capacity)) return notFound(context.response);
    const result = await context.claimService.claim(claimRequest);
    switch (result.kind) {
      case "active":
        sendJson(context.response, 200, result.claim);
        return true;
      case "conflict":
        sendJson(context.response, 409, { error: "host claim conflicts" });
        return true;
      case "empty":
        empty(context.response);
        return true;
      default:
        return assertNever(result);
    }
  }
  if (context.pathname === "/v1/host-claim-renewals") {
    const renewalRequest = parseNativeHostClaimRenewalRequest(await context.readJson());
    if (!inScope(context, hostId, renewalRequest.hostId, renewalRequest.capacity)) return notFound(context.response);
    const renewal = context.leaseService.renew(renewalRequest);
    if (renewal === undefined) sendJson(context.response, 409, { error: "host claim renewal conflicts" });
    else sendJson(context.response, 200, renewal);
    return true;
  }
  if (context.pathname === "/v1/host-results") {
    const resultRequest = parseNativeHostResultRequest(await context.readJson());
    if (!inScope(context, hostId, resultRequest.terminalEvent.payload.hostId,
      resultRequest.terminalEvent.payload.capacity)) return notFound(context.response);
    const result = context.store.acceptResult(hostId, resultRequest);
    if (result === "not-found") return notFound(context.response);
    if (result === "conflict") sendJson(context.response, 409, { error: "host result conflicts" });
    else sendJson(context.response, 202, { schemaVersion: 1, claimId: resultRequest.claimId, accepted: true });
    return true;
  }
  const recoveryRequest = parseNativeHostRecoveryRequest(await context.readJson());
  if (!inScope(context, hostId, recoveryRequest.hostId, recoveryRequest.capacity)) return notFound(context.response);
  const recovery = await context.leaseService.recover(recoveryRequest);
  if (recovery === "conflict") sendJson(context.response, 409, { error: "host recovery conflicts" });
  else empty(context.response);
  return true;
}

const hostPaths = new Set([
  "/v1/host-claims",
  "/v1/host-claim-renewals",
  "/v1/host-results",
  "/v1/host-recoveries"
]);

function inScope(context: HostHttpContext, authenticated: string, requested: string, capacity: string): boolean {
  return authenticated === requested && context.capacities.has(`${authenticated}\0${capacity}`);
}

function authenticatedHost(request: IncomingMessage, config: NativeOrdinaryAuthorityConfig): string | undefined {
  return config.hosts.find((host) => authorized(request, { username: host.hostId, password: host.hostToken }))?.hostId;
}

function knownCredential(request: IncomingMessage, config: NativeOrdinaryAuthorityConfig): boolean {
  return [
    ...Object.values(config.credentials),
    config.nativeGit.identity,
    config.nativeGit.attemptIssuer,
    config.nativeGit.resultReporter,
    ...config.hosts.map((host) => ({ username: host.hostId, password: host.hostToken }))
  ].some((credential) => authorized(request, credential));
}

function authorized(request: IncomingMessage, credential: NativeOrdinaryCredential): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function empty(response: ServerResponse): void {
  response.writeHead(204, { "cache-control": "no-store" }).end();
}

function notFound(response: ServerResponse): true {
  sendJson(response, 404, { error: "not found" });
  return true;
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected native host result: ${JSON.stringify(value)}`);
}
