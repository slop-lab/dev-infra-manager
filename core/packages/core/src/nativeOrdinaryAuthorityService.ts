import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { UserError } from "./errors.js";
import {
  createNativeGitAdmissionSource,
  createNodeNativeGitAdmissionHttpClient,
  NativeAdmissionSourceRejectedError,
  NativeAdmissionSourceUnavailableError,
  type NativeGitAdmissionHttpClient
} from "./nativeGitAdmissionSource.js";
import {
  parseNativeAdmissionPolicy,
  parseNativeAdmissionRevocation,
  parseNativeAdmissionVerification,
  parseNativeAttemptAssignment,
  parseNativeAttemptVerification
} from "./nativeOrdinaryAuthorityModel.js";
import {
  NativeOrdinaryAuthorityStore,
  type NativeOrdinaryAuthorityClock
} from "./nativeOrdinaryAuthorityStore.js";
import { parseNativeReviewJobEvent } from "./nativeOrdinaryEvent.js";
import {
  validateNativeOrdinaryAuthorityConfig,
  type NativeOrdinaryAuthorityConfig,
  type NativeOrdinaryCredential
} from "./nativeOrdinaryAuthorityConfig.js";

const maximumBodyBytes = 64 * 1024;

export type NativeOrdinaryAuthorityDependencies = {
  readonly clock?: NativeOrdinaryAuthorityClock;
  readonly nativeGitHttpClient?: NativeGitAdmissionHttpClient;
};

export type { NativeOrdinaryAuthorityConfig, NativeOrdinaryCredential } from "./nativeOrdinaryAuthorityConfig.js";

export function configuredNativeOrdinaryAuthorityServer(
  config: NativeOrdinaryAuthorityConfig,
  dependencies: NativeOrdinaryAuthorityDependencies = {}
): Server {
  const capacities = validateNativeOrdinaryAuthorityConfig(config);
  const eligibleAssignments = [...capacities.values()]
    .map(({ hostId, capacity }) => ({ hostId, capacity }))
    .sort((left, right) => `${left.hostId}\0${left.capacity}` < `${right.hostId}\0${right.capacity}` ? -1 : 1);
  const admissionSource = createNativeGitAdmissionSource({
    config: config.nativeGit,
    eligibleAssignments,
    httpClient: dependencies.nativeGitHttpClient ?? createNodeNativeGitAdmissionHttpClient()
  });
  const store = new NativeOrdinaryAuthorityStore(
    config.database,
    {
      serviceId: config.serviceId,
      leaseMilliseconds: config.admissionLeaseMilliseconds,
      capacities,
      clock: dependencies.clock ?? { now: Date.now }
    }
  );
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (error instanceof NativeAdmissionSourceUnavailableError) sendJson(response, 503, { error: error.message });
      else if (error instanceof NativeAdmissionSourceRejectedError) notFound(response);
      else if (error instanceof NativeOrdinaryRequestError) sendJson(response, error.status, { error: error.message });
      else if (error instanceof UserError) sendJson(response, 400, { error: error.message });
      else sendJson(response, 500, { error: "internal server error" });
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  server.once("close", () => store.close());
  return server;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://dim-native-ordinary");
    if (url.search !== "") return notFound(response);
    if (request.method === "GET" && url.pathname === "/v1/identity") {
      if (!authorized(request, config.credentials.query)) return notFound(response);
      return sendJson(response, 200, {
        schemaVersion: 1,
        serviceId: config.serviceId,
        role: "native-query",
        scope: ["admission:read", "attempt:read"]
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/native-events") {
      const authentication = webhookAuthentication(request, config);
      if (authentication === "invalid") return sendJson(response, 401, { error: "unauthorized" });
      if (authentication === "wrong-role") return sendJson(response, 403, { error: "forbidden" });
      const event = parseNativeReviewJobEvent(await readJson(request));
      const replay = store.checkEventReplay(event);
      if (replay === "accepted") return sendJson(response, 202, { schemaVersion: 1, eventId: event.eventId, accepted: true });
      if (replay === "full") return sendJson(response, 429, { error: "native event intake capacity is full" });
      const canonical = parseNativeReviewJobEvent(await admissionSource.assertReviewEvent(event));
      const result = store.acceptEvent(canonical);
      if (result === "accepted") return sendJson(response, 202, { schemaVersion: 1, eventId: event.eventId, accepted: true });
      if (result === "conflict") return sendJson(response, 409, { error: "event replay conflicts" });
      if (result === "full") return sendJson(response, 429, { error: "native event intake capacity is full" });
      return notFound(response);
    }
    if (request.method === "POST" && url.pathname === "/v1/operator-admissions") {
      if (!authorized(request, config.credentials.registrar)) return notFound(response);
      const requestedPolicy = parseNativeAdmissionPolicy(await readJson(request));
      const policy = parseNativeAdmissionPolicy(await admissionSource.assertRegisteredPolicy(requestedPolicy));
      if (!policy.eligibleAssignments.every((assignment) => capacities.has(`${assignment.hostId}\0${assignment.capacity}`))) {
        return notFound(response);
      }
      const admission = store.admit(policy);
      return sendJson(response, 200, {
        schemaVersion: 1,
        serviceId: config.serviceId,
        projectId: policy.projectId,
        repositoryId: policy.repositoryId,
        admissionGeneration: admission.admissionGeneration,
        expiresAt: admission.expiresAt
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/operator-admission-revocations") {
      if (!authorized(request, config.credentials.registrar)) return notFound(response);
      const input = parseNativeAdmissionRevocation(await readJson(request));
      if (!store.revoke(input.projectId, input.repositoryId, input.admissionGeneration)) return notFound(response);
      response.writeHead(204, { "cache-control": "no-store" }).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/current-attempt-assignments") {
      if (!authorized(request, config.credentials.scheduler)) return notFound(response);
      const requestedAssignment = parseNativeAttemptAssignment(await readJson(request));
      const assignment = parseNativeAttemptAssignment(await admissionSource.assertIssuedAttempt(requestedAssignment));
      if (!store.assign(assignment)) return notFound(response);
      response.writeHead(204, { "cache-control": "no-store" }).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/admission-verifications") {
      if (!authorized(request, config.credentials.query)) return notFound(response);
      const verification = parseNativeAdmissionVerification(await readJson(request));
      if (!store.admitted(verification)) return notFound(response);
      return sendJson(response, 200, { ...verification, serviceId: config.serviceId, authorized: true });
    }
    if (request.method === "POST" && url.pathname === "/v1/current-attempt-verifications") {
      if (!authorized(request, config.credentials.query)) return notFound(response);
      const verification = parseNativeAttemptVerification(await readJson(request));
      if (!store.current(verification)) return notFound(response);
      return sendJson(response, 200, { ...verification, serviceId: config.serviceId, authorized: true });
    }
    notFound(response);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") {
    throw new NativeOrdinaryRequestError(415, "content type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBodyBytes) throw new NativeOrdinaryRequestError(413, "request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UserError("request body must be valid JSON", { cause: error });
    throw error;
  }
}

function authorized(request: IncomingMessage, credential: NativeOrdinaryCredential): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function webhookAuthentication(
  request: IncomingMessage,
  config: NativeOrdinaryAuthorityConfig
): "authorized" | "invalid" | "wrong-role" {
  if (authorized(request, config.credentials.webhook)) return "authorized";
  const knownCredentials = [
    config.credentials.registrar,
    config.credentials.query,
    config.credentials.scheduler,
    config.nativeGit.identity
  ];
  return knownCredentials.some((credential) => authorized(request, credential)) ? "wrong-role" : "invalid";
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse): void {
  sendJson(response, 404, { error: "not found" });
}

class NativeOrdinaryRequestError extends Error {
  readonly name = "NativeOrdinaryRequestError";

  constructor(readonly status: 413 | 415, message: string) {
    super(message);
  }
}
