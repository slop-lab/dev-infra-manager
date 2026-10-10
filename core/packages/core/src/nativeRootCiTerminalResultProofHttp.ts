import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { UserError } from "./errors.js";
import type { NativeOrdinaryAuthorityConfig, NativeOrdinaryCredential } from "./nativeOrdinaryAuthorityConfig.js";
import {
  createNativeRootCiCurrentTerminalProof,
  NativeRootCiCurrentTerminalProofTooLargeError,
  parseNativeRootCiCurrentTerminalProofRequest
} from "./nativeRootCiTerminalResultProofModel.js";
import type { NativeRootCiTerminalResultProofStore } from "./nativeRootCiTerminalResultProofStore.js";
import { sqliteUnavailable } from "./nativeSqliteAvailability.js";

const maximumBodyBytes = 64 * 1024;
const proofRoute = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/root\/native-root-ci-result-proof\/current-terminal$/;

type TerminalProofHttpOptions = {
  readonly config: NativeOrdinaryAuthorityConfig;
  readonly generationId: string;
  readonly store: NativeRootCiTerminalResultProofStore;
  readonly active: () => boolean;
};

export function createNativeRootCiTerminalResultProofHandler(options: TerminalProofHttpOptions) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (url.search !== "") return false;
    const projectId = request.method === "POST" ? proofRoute.exec(url.pathname)?.[1] : undefined;
    if (projectId === undefined) return false;
    if (!authorized(request, options.config.credentials.query)) {
      return authenticationFailure(request, response, options.config);
    }
    if (!options.active()) return sendJson(response, 503,
      { error: "native root CI current-terminal proof requires exact generation activation" });
    try {
      const input = parseNativeRootCiCurrentTerminalProofRequest(await readJson(request));
      if (input.generationId !== options.generationId) {
        return sendJson(response, 409, { error: "native root CI current-terminal proof generation is stale" });
      }
      const result = options.store.current(projectId, input);
      switch (result.kind) {
        case "found": return sendJson(response, 200, createNativeRootCiCurrentTerminalProof({
          serviceId: options.config.serviceId, requestId: input.requestId,
          servingGenerationId: options.generationId, projectId, ...result.proof
        }));
        case "conflict": return sendJson(response, 409,
          { error: "native root CI current-terminal proof conflicts with current state" });
        case "not-found": return notFound(response);
        default: return assertNever(result);
      }
    } catch (error) {
      if (error instanceof TerminalProofHttpError) return sendJson(response, error.status, { error: error.message });
      if (error instanceof NativeRootCiCurrentTerminalProofTooLargeError) {
        return sendJson(response, 413, { error: error.message });
      }
      if (sqliteUnavailable(error)) return sendJson(response, 503,
        { error: "native root CI current-terminal proof is unavailable" });
      if (error instanceof UserError) return sendJson(response, 400, { error: error.message });
      throw error;
    }
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") {
    throw new TerminalProofHttpError(415, "content type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBodyBytes) throw new TerminalProofHttpError(413, "request body is too large");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new TerminalProofHttpError(400, "request body must be valid JSON");
    throw error;
  }
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
function notFound(response: ServerResponse): true { return sendJson(response, 404, { error: "not found" }); }
function assertNever(value: never): never { throw new TypeError(`unexpected current-terminal proof: ${JSON.stringify(value)}`); }
class TerminalProofHttpError extends Error {
  readonly name = "TerminalProofHttpError";
  constructor(readonly status: 400 | 413 | 415, message: string) { super(message); }
}
