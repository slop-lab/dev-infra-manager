import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { UserError } from "./errors.js";
import {
  parseNativeAdmissionPolicy,
  parseNativeAdmissionRevocation,
  parseNativeAdmissionVerification,
  parseNativeAttemptAssignment,
  parseNativeAttemptVerification,
  resourceBounds,
  type NativeAdmissionPolicy,
  type NativeAttemptAssignment,
  type NativeCapacityPolicy
} from "./nativeOrdinaryAuthorityModel.js";
import {
  NativeOrdinaryAuthorityStore,
  type NativeOrdinaryAuthorityClock
} from "./nativeOrdinaryAuthorityStore.js";

const maximumBodyBytes = 64 * 1024;

export type NativeOrdinaryCredential = {
  readonly username: string;
  readonly password: string;
};

export interface NativeAdmissionSource {
  assertRegisteredPolicy(input: NativeAdmissionPolicy): Promise<NativeAdmissionPolicy>;
  assertIssuedAttempt(input: NativeAttemptAssignment): Promise<NativeAttemptAssignment>;
}

export type NativeOrdinaryAuthorityDependencies = {
  readonly clock?: NativeOrdinaryAuthorityClock;
  readonly admissionSource?: NativeAdmissionSource;
};

export type NativeOrdinaryAuthorityConfig = {
  readonly schemaVersion: 3;
  readonly serviceId: string;
  readonly database: string;
  readonly admissionLeaseMilliseconds: number;
  readonly credentials: {
    readonly registrar: NativeOrdinaryCredential;
    readonly query: NativeOrdinaryCredential;
    readonly scheduler: NativeOrdinaryCredential;
  };
  readonly hosts: readonly {
    readonly hostId: string;
    readonly capacities: readonly {
      readonly capacity: string;
      readonly runnerBaseImage: string;
      readonly bounds: NativeCapacityPolicy["bounds"];
    }[];
  }[];
};

export function configuredNativeOrdinaryAuthorityServer(
  config: NativeOrdinaryAuthorityConfig,
  dependencies: NativeOrdinaryAuthorityDependencies = {}
): Server {
  const capacities = validateConfig(config);
  const admissionSource = dependencies.admissionSource ?? rejectingNativeAdmissionSource;
  const store = new NativeOrdinaryAuthorityStore(
    config.database,
    config.serviceId,
    config.admissionLeaseMilliseconds,
    capacities,
    dependencies.clock ?? { now: Date.now }
  );
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (error instanceof NativeAdmissionSourceUnavailableError) sendJson(response, 503, { error: error.message });
      else if (error instanceof NativeAdmissionSourceRejectedError) notFound(response);
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

const rejectingNativeAdmissionSource: NativeAdmissionSource = {
  async assertRegisteredPolicy() {
    throw new NativeAdmissionSourceUnavailableError();
  },
  async assertIssuedAttempt() {
    throw new NativeAdmissionSourceUnavailableError();
  }
};

export class NativeAdmissionSourceUnavailableError extends Error {
  readonly name = "NativeAdmissionSourceUnavailableError";

  constructor() {
    super("native admission source is unavailable");
  }
}

export class NativeAdmissionSourceRejectedError extends Error {
  readonly name = "NativeAdmissionSourceRejectedError";

  constructor() {
    super("native admission source rejected the tuple");
  }
}

function validateConfig(config: NativeOrdinaryAuthorityConfig): ReadonlyMap<string, NativeCapacityPolicy> {
  if (config.schemaVersion !== 3) throw new UserError("native ordinary authority schemaVersion must be 3");
  authorityIdentifier(config.serviceId, "service ID");
  if (config.database.length === 0) throw new UserError("native ordinary authority database path must not be empty");
  if (!Number.isSafeInteger(config.admissionLeaseMilliseconds) || config.admissionLeaseMilliseconds < 1) {
    throw new UserError("native ordinary authority admission lease must be positive");
  }
  const credentials = Object.values(config.credentials);
  for (const credential of credentials) {
    authorityIdentifier(credential.username, "credential username");
    if (!/^[A-Za-z0-9_-]{32,}$/.test(credential.password)) throw new UserError("native ordinary authority passwords must be base64url and at least 32 characters");
  }
  if (new Set(credentials.flatMap((credential) => [credential.username, credential.password])).size !== credentials.length * 2) {
    throw new UserError("native ordinary authority credentials must be distinct");
  }
  const capacities = new Map<string, NativeCapacityPolicy>();
  for (const host of config.hosts) {
    authorityIdentifier(host.hostId, "host ID");
    for (const capacity of host.capacities) {
      authorityIdentifier(capacity.capacity, "capacity");
      const key = `${host.hostId}\0${capacity.capacity}`;
      if (capacities.has(key)) throw new UserError("native ordinary authority capacities must be unique");
      if (!/^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/.test(capacity.runnerBaseImage)) {
        throw new UserError("native ordinary authority runner base image is invalid");
      }
      capacities.set(key, {
        hostId: host.hostId,
        capacity: capacity.capacity,
        runnerBaseImage: capacity.runnerBaseImage,
        bounds: resourceBounds(capacity.bounds)
      });
    }
  }
  if (capacities.size === 0) throw new UserError("native ordinary authority requires at least one capacity");
  return capacities;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw new UserError("content type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBodyBytes) throw new UserError("request body is too large");
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

function authorityIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) throw new UserError(`${label} is invalid`);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse): void {
  sendJson(response, 404, { error: "not found" });
}
