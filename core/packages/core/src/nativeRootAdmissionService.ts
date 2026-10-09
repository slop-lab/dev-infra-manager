import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";
import type { NativeOrdinaryAuthorityConfig, NativeOrdinaryCredential } from "./nativeOrdinaryAuthorityConfig.js";
import { validateNativeOrdinaryAuthorityConfig } from "./nativeOrdinaryAuthorityConfig.js";
import { nativeCapacityConfigDigest } from "./nativeOrdinaryAuthorityProtocol.js";
import {
  parseNativeRootAdmissionRequest,
  nativeRootAdmissionTupleDigest,
  NativeRootAdmissionRequestError,
  type NativeRootAdmissionOperation
} from "./nativeRootAdmissionModel.js";
import { NativeRootAdmissionStore } from "./nativeRootAdmissionStore.js";
import {
  createNativeRootCiProofClient,
  NativeRootCiProofRejectedError,
  NativeRootCiProofUnavailableError,
  type NativeRootCiProofHttpClient
} from "./nativeRootCiProofClient.js";
import { initializeNativeOrdinaryBundleState, secureNativeOrdinaryDatabaseFiles } from "./nativeOrdinaryBundleState.js";
import { createNativeRootCiEventReceiptHandler } from "./nativeRootCiEventReceiptHttp.js";
import { NativeRootCiEventReceiptStore } from "./nativeRootCiEventReceiptStore.js";

const maximumBodyBytes = 4 * 1024;
const projectPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type NativeRootAdmissionServiceOptions = {
  readonly config: NativeOrdinaryAuthorityConfig;
  readonly stateDirectory: string;
  readonly readinessToken: string;
  readonly activationToken: string;
  readonly expectedGenerationId: string;
  readonly proofHttpClient?: NativeRootCiProofHttpClient;
  readonly now?: () => number;
};

export async function configuredNativeRootAdmissionServer(
  options: NativeRootAdmissionServiceOptions
): Promise<Server> {
  const capacities = validateNativeOrdinaryAuthorityConfig(options.config);
  assertToken(options.readinessToken, "readiness");
  assertToken(options.activationToken, "activation");
  assertGeneration(options.expectedGenerationId);
  assertDistinctTokens(options);
  const state = await initializeNativeOrdinaryBundleState(options.stateDirectory);
  const database = new DatabaseSync(state.database);
  try { database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    await secureNativeOrdinaryDatabaseFiles(options.stateDirectory); }
  catch (error) { database.close(); throw error; }
  const capacityConfigDigest = nativeCapacityConfigDigest([...capacities.values()]);
  const store = new NativeRootAdmissionStore(database, { ordinaryServiceId: options.config.serviceId,
    controlPlaneGenerationId: options.expectedGenerationId, capacityConfigDigest,
    leaseMilliseconds: options.config.admissionLeaseMilliseconds, now: options.now ?? Date.now });
  const proofClient = createNativeRootCiProofClient({ endpoint: options.config.nativeGit.endpoint,
    serviceId: options.config.nativeGit.serviceId, generationId: options.expectedGenerationId,
    identity: options.config.nativeGit.identity }, options.proofHttpClient);
  const activationDigest = tokenDigest(options.activationToken);
  let activated = false;
  const activationBound = () => activationIsBound(database, options.expectedGenerationId, activationDigest);
  const receiptStore = new NativeRootCiEventReceiptStore(database, { ordinaryServiceId: options.config.serviceId,
    controlPlaneGenerationId: options.expectedGenerationId, capacityConfigDigest,
    activated: () => activated, activationBound, now: options.now ?? Date.now });
  const handleReceipt = createNativeRootCiEventReceiptHandler({ config: options.config,
    expectedGenerationId: options.expectedGenerationId, store: receiptStore, proofClient,
    activated: () => activated, activationBound });
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => sendError(response, error));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  server.once("close", () => database.close());
  return server;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://dim-native-root-admission");
    if (url.search !== "") return notFound(response);
    if (request.method === "GET" && url.pathname === "/readyz") {
      if (!bearerAuthorized(request, options.readinessToken)) return notFound(response);
      database.prepare("SELECT 1").get();
      return sendJson(response, 200, { status: "ready", schemaVersion: 1 });
    }
    if (request.method === "GET" && url.pathname === "/v1/native-root-admission/identity") {
      if (basicAuthorized(request, options.config.credentials.registrar)) return sendJson(response, 200, identity("registrar"));
      if (basicAuthorized(request, options.config.credentials.query)) return sendJson(response, 200, identity("reader"));
      return notFound(response);
    }
    if (request.method === "POST" && url.pathname === "/v1/activation") {
      if (request.socket.remoteAddress !== "127.0.0.1"
        || !bearerAuthorized(request, options.activationToken)) return notFound(response);
      const generationId = activationGeneration(await readJson(request));
      if (generationId !== options.expectedGenerationId) return sendJson(response, 409,
        { error: "activation generation conflicts with service startup" });
      if (!bindActivation(database, generationId, activationDigest)) return sendJson(response, 409,
        { error: "ordinary CI activation binding conflicts with durable state" });
      store.activate();
      activated = true;
      return sendJson(response, 200, { schemaVersion: 1, generationId, activated: true });
    }
    if (await handleReceipt(request, response, url)) return;
    const route = admissionRoute(url.pathname);
    if (request.method !== "POST" || route === undefined) return notFound(response);
    const credential = route.operation === "current" ? options.config.credentials.query : options.config.credentials.registrar;
    if (!basicAuthorized(request, credential)) return notFound(response);
    if (!activated || !activationIsBound(database, options.expectedGenerationId, activationDigest)) {
      return sendJson(response, 503, { error: "native root admission requires exact generation activation" });
    }
    const input = parseNativeRootAdmissionRequest(await readJson(request), route.operation);
    if (input.generationId !== options.expectedGenerationId) {
      return sendJson(response, 409, { error: "native root admission generation is stale" });
    }
    const tupleDigest = nativeRootAdmissionTupleDigest(route.operation, route.projectId, input);
    const replay = store.replay(input.requestId, route.operation, tupleDigest);
    switch (replay.kind) {
      case "conflict": return sendJson(response, 409, { error: "request replay conflicts" });
      case "replay": return sendJson(response, replay.response.status, replay.response.body);
      case "none": break;
      default: return assertNever(replay);
    }
    if (!store.hasRequestCapacity()) {
      return sendJson(response, 429, { error: "native root admission request capacity is full" });
    }
    if (route.operation === "register") {
      const proof = await proofClient.readImportedPolicy(route.projectId, AbortSignal.timeout(5_000));
      return sendAdmissionResult(response, store.commitRegistration({ proof, request: {
        requestId: input.requestId, operation: route.operation, tupleDigest,
        responseBody: (admission) => responseBody(input.requestId, admission)
      } }));
    }
    const admissionGeneration = input.admissionGeneration;
    if (admissionGeneration === undefined) throw new NativeRootAdmissionRequestError("admission generation is required");
    return sendAdmissionResult(response, store.commitExisting({ projectId: route.projectId, admissionGeneration,
      request: { requestId: input.requestId, operation: route.operation, tupleDigest,
        responseBody: (admission) => responseBody(input.requestId, admission) } }));
  }

  function identity(role: "registrar" | "reader"): unknown {
    return role === "registrar" ? { schemaVersion: 1, serviceId: options.config.serviceId,
      servingGenerationId: options.expectedGenerationId, role: "native-root-admission-registrar",
      scope: ["imported-root-admission:write", "imported-root-admission:revoke"] }
      : { schemaVersion: 1, serviceId: options.config.serviceId,
        servingGenerationId: options.expectedGenerationId, role: "native-root-admission-reader",
        scope: ["imported-root-admission:read"] };
  }

  function responseBody(requestId: string, admission: import("./nativeRootAdmissionModel.js").NativeRootAdmission): unknown {
    return { schemaVersion: 1, serviceId: options.config.serviceId, requestId,
      servingGenerationId: options.expectedGenerationId, admission };
  }

  function sendAdmissionResult(response: ServerResponse,
    result: ReturnType<NativeRootAdmissionStore["commitRegistration"]>): void {
    switch (result.kind) {
      case "committed":
      case "replay": return sendJson(response, result.response.status, result.response.body);
      case "request-conflict": return sendJson(response, 409, { error: "request replay conflicts" });
      case "capacity-full": return sendJson(response, 429, { error: "native root admission request capacity is full" });
      case "operation-conflict": return sendJson(response, 409, { error: "current imported root conflicts" });
      case "not-found": return notFound(response);
      default: return assertNever(result);
    }
  }
}

function admissionRoute(path: string): { readonly projectId: string; readonly operation: NativeRootAdmissionOperation } | undefined {
  const match = /^\/v1\/projects\/([^/]+)\/repositories\/root\/native-root-admission\/(register|current|revoke)$/.exec(path);
  if (match === null || !projectPattern.test(match[1] ?? "")) return undefined;
  const operation = match[2];
  if (operation !== "register" && operation !== "current" && operation !== "revoke") return undefined;
  return { projectId: match[1] ?? "", operation };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw new AdmissionHttpError(415, "content type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBodyBytes) throw new AdmissionHttpError(413, "request body is too large");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new NativeRootAdmissionRequestError("request body must be valid JSON");
    throw error;
  }
}

function activationGeneration(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 2
    || Reflect.get(value, "schemaVersion") !== 1 || typeof Reflect.get(value, "generationId") !== "string"
    || !/^[0-9a-f]{64}$/.test(String(Reflect.get(value, "generationId")))) {
    throw new NativeRootAdmissionRequestError("activation request is invalid");
  }
  return String(Reflect.get(value, "generationId"));
}

function bindActivation(database: DatabaseSync, generation: string, digest: string): boolean {
  const generationRow = database.prepare("SELECT activation_token_sha256 FROM bundle_activation WHERE generation_id = ?").get(generation);
  const bound = generationRow === undefined ? undefined : Reflect.get(generationRow, "activation_token_sha256");
  if (typeof bound === "string") return safeEqual(bound, digest);
  if (database.prepare("SELECT 1 FROM bundle_activation WHERE activation_token_sha256 = ?").get(digest) !== undefined) return false;
  database.prepare("INSERT INTO bundle_activation(generation_id, activation_token_sha256) VALUES (?, ?)").run(generation, digest);
  return true;
}
function activationIsBound(database: DatabaseSync, generation: string, digest: string): boolean {
  const row = database.prepare(`SELECT 1 FROM bundle_activation
    WHERE generation_id = ? AND activation_token_sha256 = ?`).get(generation, digest);
  return row !== undefined;
}

function assertDistinctTokens(options: NativeRootAdmissionServiceOptions): void {
  const configured = [...Object.values(options.config.credentials).map(({ password }) => password),
    options.config.nativeGit.identity.password, options.config.nativeGit.attemptIssuer.password,
    options.config.nativeGit.resultReporter.password, ...options.config.hosts.map(({ hostToken }) => hostToken)];
  if (options.readinessToken === options.activationToken || configured.includes(options.readinessToken)
    || configured.includes(options.activationToken)) throw new UserError("ordinary CI service tokens must be distinct");
}
function assertToken(value: string, label: string): void {
  const decoded = Buffer.from(value, "base64url");
  if (!/^[A-Za-z0-9_-]+$/.test(value) || decoded.length < 32 || decoded.toString("base64url") !== value) {
    throw new UserError(`ordinary CI ${label} token is invalid`);
  }
}
function assertGeneration(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new UserError("ordinary CI startup generation is invalid");
}
function basicAuthorized(request: IncomingMessage, credential: NativeOrdinaryCredential): boolean {
  return headerAuthorized(request, `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`);
}
function bearerAuthorized(request: IncomingMessage, token: string): boolean { return headerAuthorized(request, `Bearer ${token}`); }
function headerAuthorized(request: IncomingMessage, expected: string): boolean {
  const actual = Buffer.from(request.headers.authorization ?? "");
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
function tokenDigest(token: string): string { return createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex"); }
function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof NativeRootCiProofUnavailableError) return sendJson(response, 503, { error: error.message });
  if (error instanceof NativeRootCiProofRejectedError) return sendJson(response, error.statusCode, { error: error.message });
  if (error instanceof AdmissionHttpError) return sendJson(response, error.status, { error: error.message });
  if (error instanceof NativeRootAdmissionRequestError || error instanceof UserError) return sendJson(response, 400, { error: error.message });
  return sendJson(response, 500, { error: "internal server error" });
}
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
function notFound(response: ServerResponse): void { sendJson(response, 404, { error: "not found" }); }
function assertNever(value: never): never { throw new TypeError(`unexpected native root admission result: ${JSON.stringify(value)}`); }
class AdmissionHttpError extends Error {
  readonly name = "AdmissionHttpError";
  constructor(readonly status: 413 | 415, message: string) { super(message); }
}
