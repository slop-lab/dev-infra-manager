import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";
import type { NativeOrdinaryAuthorityConfig, NativeOrdinaryCredential } from "./nativeOrdinaryAuthorityConfig.js";
import { validateNativeOrdinaryAuthorityConfig } from "./nativeOrdinaryAuthorityConfig.js";
import {
  initializeNativeOrdinaryBundleState,
  secureNativeOrdinaryDatabaseFiles
} from "./nativeOrdinaryBundleState.js";

const maximumBodyBytes = 4 * 1024;

export type NativeOrdinaryIdleServiceOptions = {
  readonly config: NativeOrdinaryAuthorityConfig;
  readonly stateDirectory: string;
  readonly readinessToken: string;
  readonly activationToken: string;
  readonly expectedGenerationId: string;
};

export async function configuredNativeOrdinaryIdleServer(
  options: NativeOrdinaryIdleServiceOptions
): Promise<Server> {
  validateNativeOrdinaryAuthorityConfig(options.config);
  assertToken(options.readinessToken, "readiness");
  assertToken(options.activationToken, "activation");
  assertGenerationId(options.expectedGenerationId);
  const configuredTokens = [
    ...Object.values(options.config.credentials).map((credential) => credential.password),
    options.config.nativeGit.identity.password,
    options.config.nativeGit.attemptIssuer.password,
    options.config.nativeGit.resultReporter.password,
    ...options.config.hosts.map((host) => host.hostToken)
  ];
  if (options.readinessToken === options.activationToken || configuredTokens.includes(options.readinessToken)
    || configuredTokens.includes(options.activationToken)) {
    throw new UserError("ordinary CI readiness, activation, and service tokens must be distinct");
  }
  const activationTokenSha256 = tokenSha256(options.activationToken);
  const state = await initializeNativeOrdinaryBundleState(options.stateDirectory);
  const database = new DatabaseSync(state.database);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
  await secureNativeOrdinaryDatabaseFiles(options.stateDirectory);
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (error instanceof IdleRequestError) sendJson(response, error.status, { error: error.message });
      else if (error instanceof UserError) sendJson(response, 400, { error: error.message });
      else sendJson(response, 500, { error: "internal server error" });
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  server.once("close", () => database.close());
  return server;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://dim-native-ordinary-idle");
    if (url.search !== "") return notFound(response);
    if (request.method === "GET" && url.pathname === "/readyz") {
      if (!bearerAuthorized(request, options.readinessToken)) return notFound(response);
      database.prepare("SELECT 1").get();
      return sendJson(response, 200, { status: "ready", schemaVersion: 1 });
    }
    if (request.method === "GET" && url.pathname === "/v1/identity") {
      if (!basicAuthorized(request, options.config.credentials.query)) return notFound(response);
      return sendJson(response, 200, {
        schemaVersion: 1,
        serviceId: options.config.serviceId,
        role: "native-query",
        scope: ["admission:read", "attempt:read"]
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/activation") {
      if (request.socket.remoteAddress !== "127.0.0.1") return notFound(response);
      if (!bearerAuthorized(request, options.activationToken)) return notFound(response);
      const generationId = activationGeneration(await readJson(request));
      if (generationId !== options.expectedGenerationId) {
        return sendJson(response, 409, { error: "activation generation conflicts with service startup" });
      }
      if (!bindActivation(database, generationId, activationTokenSha256)) {
        return sendJson(response, 409, { error: "ordinary CI activation binding conflicts with durable state" });
      }
      return sendJson(response, 200, { schemaVersion: 1, generationId, activated: true });
    }
    if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH"
      || request.method === "DELETE") {
      return sendJson(response, 503, { error: "ordinary CI business mutations are unavailable in idle deployment" });
    }
    notFound(response);
  }
}

function activationGeneration(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.schemaVersion !== 1
    || typeof value.generationId !== "string" || !/^[0-9a-f]{64}$/.test(value.generationId)) {
    throw new UserError("activation request is invalid");
  }
  return value.generationId;
}

function assertGenerationId(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new UserError("ordinary CI startup generation is invalid");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") {
    throw new IdleRequestError(415, "content type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBodyBytes) throw new IdleRequestError(413, "request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UserError("request body must be valid JSON", { cause: error });
    throw error;
  }
}

function basicAuthorized(request: IncomingMessage, credential: NativeOrdinaryCredential): boolean {
  const expected = `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`;
  return safeHeaderEqual(request.headers.authorization, expected);
}

function bearerAuthorized(request: IncomingMessage, token: string): boolean {
  return safeHeaderEqual(request.headers.authorization, `Bearer ${token}`);
}

function safeHeaderEqual(actual: string | undefined, expected: string): boolean {
  const actualBytes = Buffer.from(actual ?? "");
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function assertToken(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new UserError(`ordinary CI ${label} token is invalid`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length < 32 || decoded.toString("base64url") !== value) {
    throw new UserError(`ordinary CI ${label} token is invalid`);
  }
}

function activationTokenSha256Field(row: unknown): string | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const value = Reflect.get(row, "activation_token_sha256");
  return typeof value === "string" ? value : undefined;
}

function bindActivation(database: DatabaseSync, generationId: string, activationTokenSha256: string): boolean {
  database.exec("BEGIN IMMEDIATE");
  try {
    const boundTokenSha256 = activationTokenSha256Field(database.prepare(
      "SELECT activation_token_sha256 FROM bundle_activation WHERE generation_id = ?"
    ).get(generationId));
    if (boundTokenSha256 !== undefined) {
      if (!safeDigestEqual(boundTokenSha256, activationTokenSha256)) {
        database.exec("ROLLBACK");
        return false;
      }
      database.exec("COMMIT");
      return true;
    }
    const tokenIsBound = database.prepare(
      "SELECT 1 FROM bundle_activation WHERE activation_token_sha256 = ?"
    ).get(activationTokenSha256) !== undefined;
    if (tokenIsBound) {
      database.exec("ROLLBACK");
      return false;
    }
    database.prepare(
      "INSERT INTO bundle_activation(generation_id, activation_token_sha256) VALUES (?, ?)"
    ).run(generationId, activationTokenSha256);
    database.exec("COMMIT");
    return true;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function tokenSha256(token: string): string {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex");
}

function safeDigestEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse): void {
  sendJson(response, 404, { error: "not found" });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class IdleRequestError extends Error {
  readonly name = "IdleRequestError";

  constructor(readonly status: 413 | 415, message: string) {
    super(message);
  }
}
