import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { parseNativeGitBundleConfig, type NativeGitBundleConfig } from "./bundle-config.js";
import { initializeNativeGitBundleState } from "./native-bundle-state.js";
import { readNativeProjectRegistrationsFromDatabase } from "./native-project-registry-state.js";
import {
  createNodeAdmissionVerifierHttpClient,
  createOrdinaryAdmissionVerifier,
  type AdmissionVerifierHttpClient
} from "./ordinary-admission-http.js";

const maximumBodyBytes = 4 * 1024;
const identityTimeoutMilliseconds = 2_000;

export type NativeGitIdleServiceOptions = {
  readonly config: NativeGitBundleConfig;
  readonly stateDirectory: string;
  readonly readinessToken: string;
  readonly activationToken: string;
  readonly expectedGenerationId: string;
  readonly ordinaryIdentityHttpClient?: AdmissionVerifierHttpClient;
};

export async function configuredNativeGitIdleServer(options: NativeGitIdleServiceOptions): Promise<Server> {
  const config = parseNativeGitBundleConfig(options.config);
  if (config.projectRegistrars.length !== 0) {
    throw new NativeGitIdleServiceError("native Git idle service cannot use Project registrar credentials");
  }
  if (config.projectRootImporters.length !== 0) {
    throw new NativeGitIdleServiceError("native Git idle service cannot use Project root importer credentials");
  }
  if (config.projectRootReadIssuers.length !== 0) {
    throw new NativeGitIdleServiceError("native Git idle service cannot use Project root read issuer credentials");
  }
  if (config.workspaceWriteIssuers.length !== 0) {
    throw new NativeGitIdleServiceError("native Git idle service cannot use workspace write issuer credentials");
  }
  if (config.humanReviewers.length !== 0) {
    throw new NativeGitIdleServiceError("native Git idle service cannot use human reviewer credentials");
  }
  assertToken(options.readinessToken, "readiness");
  assertToken(options.activationToken, "activation");
  assertGenerationId(options.expectedGenerationId);
  const credentials = [
    config.ordinaryCi.query,
    config.ordinaryCi.identity,
    config.ordinaryCi.attemptIssuer,
    config.ordinaryCi.resultReporter,
    config.ordinaryCi.webhook
  ].flatMap((credential) => [credential.username, credential.password]);
  if (options.readinessToken === options.activationToken || credentials.includes(options.readinessToken)
    || credentials.includes(options.activationToken)) {
    throw new NativeGitIdleServiceError("native Git readiness, activation, and service credentials must be distinct");
  }
  const activationTokenSha256 = tokenSha256(options.activationToken);
  const state = await initializeNativeGitBundleState(options.stateDirectory, options.expectedGenerationId);
  let database: DatabaseSync;
  try {
    if (readNativeProjectRegistrationsFromDatabase(state.database).length !== 0) {
      throw new NativeGitIdleServiceError("native Git idle service cannot conceal a registered Project");
    }
    database = new DatabaseSync(state.database, { defensive: true });
    database.exec("PRAGMA synchronous = FULL");
  } catch (error) {
    await state.owner.release();
    throw error;
  }
  const identityHttpClient = options.ordinaryIdentityHttpClient ?? createNodeAdmissionVerifierHttpClient();
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (error instanceof IdleRequestError) sendJson(response, error.status, { error: error.message });
      else if (error instanceof NativeGitIdleServiceError) sendJson(response, 400, { error: error.message });
      else sendJson(response, 500, { error: "internal server error" });
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  server.once("close", () => {
    database.close();
    void state.owner.release();
  });
  return server;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://dim-native-git-idle");
    if (url.search !== "") return notFound(response);
    if (request.method === "GET" && url.pathname === "/readyz") {
      if (!bearerAuthorized(request, options.readinessToken)) return notFound(response);
      database.prepare("SELECT 1").get();
      try {
        await createOrdinaryAdmissionVerifier({
          config: config.ordinaryCi,
          httpClient: identityHttpClient,
          timeoutMilliseconds: identityTimeoutMilliseconds
        });
      } catch (error) {
        if (error instanceof Error) {
          return sendJson(response, 503, { error: "ordinary CI identity is unavailable" });
        }
        throw error;
      }
      return sendJson(response, 200, { status: "ready", schemaVersion: 1 });
    }
    if (request.method === "POST" && url.pathname === "/v1/activation") {
      if (request.socket.remoteAddress !== "127.0.0.1") return notFound(response);
      if (!bearerAuthorized(request, options.activationToken)) return notFound(response);
      const generationId = activationGeneration(await readJson(request));
      if (generationId !== options.expectedGenerationId) {
        return sendJson(response, 409, { error: "activation generation conflicts with service startup" });
      }
      if (!bindActivation(database, generationId, activationTokenSha256)) {
        return sendJson(response, 409, { error: "native Git activation binding conflicts with durable state" });
      }
      return sendJson(response, 200, { schemaVersion: 1, generationId, activated: true });
    }
    if (isBusinessRequest(request.method, url.pathname)) {
      return sendJson(response, 503, { error: "native Git business operations are unavailable in idle deployment" });
    }
    notFound(response);
  }
}

function isBusinessRequest(method: string | undefined, path: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE"
    || path.startsWith("/v1/projects/") || path.includes(".git/");
}

function activationGeneration(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.schemaVersion !== 1
    || typeof value.generationId !== "string" || !/^[0-9a-f]{64}$/.test(value.generationId)) {
    throw new NativeGitIdleServiceError("activation request is invalid");
  }
  return value.generationId;
}

function assertGenerationId(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new NativeGitIdleServiceError("native Git startup generation is invalid");
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
    if (error instanceof SyntaxError) throw new NativeGitIdleServiceError("request body must be valid JSON", { cause: error });
    throw error;
  }
}

function bearerAuthorized(request: IncomingMessage, token: string): boolean {
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function assertToken(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new NativeGitIdleServiceError(`native Git ${label} token is invalid`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length < 32 || decoded.toString("base64url") !== value) {
    throw new NativeGitIdleServiceError(`native Git ${label} token is invalid`);
  }
}

function activationTokenSha256Field(row: unknown): string | undefined {
  if (!isRecord(row)) return undefined;
  return typeof row.activation_token_sha256 === "string" ? row.activation_token_sha256 : undefined;
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
  constructor(readonly status: 413 | 415, message: string) { super(message); }
}

export class NativeGitIdleServiceError extends Error {
  readonly name = "NativeGitIdleServiceError";
}
