import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { UserError } from "@slop-lab/dim-core";
import type { NativeCapacityPolicy } from "./nativeOrdinaryAuthorityModel.js";
import type { NativeOrdinaryAuthorityConfig, NativeOrdinaryCredential } from "./nativeOrdinaryAuthorityConfig.js";
import { parseNativeRootCiHostResultRequest } from "./nativeRootCiResultProtocol.js";
import type { NativeRootCiResultStore } from "./nativeRootCiResultStore.js";

const maximumBodyBytes = 64 * 1024;

type ResultHttpOptions = {
  readonly config: NativeOrdinaryAuthorityConfig;
  readonly generationId: string;
  readonly capacities: ReadonlyMap<string, NativeCapacityPolicy>;
  readonly store: NativeRootCiResultStore;
  readonly active: () => boolean;
};

export function createNativeRootCiResultHandler(options: ResultHttpOptions) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (url.search !== "" || url.pathname !== "/v1/host-results") return false;
    if (request.method !== "POST") return notFound(response);
    const hostId = authenticatedHost(request, options.config);
    if (hostId === undefined) return authenticationFailure(request, response, options.config);
    if (!options.active()) return sendJson(response, 503,
      { error: "native root CI host result requires exact generation activation" });
    try {
      const input = parseNativeRootCiHostResultRequest(await readJson(request));
      if (input.generationId !== options.generationId) {
        return sendJson(response, 409, { error: "native root CI host result generation is stale" });
      }
      if (input.terminalEvent.payload.hostId !== hostId
        || !options.capacities.has(`${hostId}\0${input.terminalEvent.payload.capacity}`)) return notFound(response);
      const result = options.store.accept(hostId, input);
      switch (result) {
        case "accepted": return sendJson(response, 202,
          { schemaVersion: 1, claimId: input.claimId, accepted: true });
        case "conflict": return sendJson(response, 409, { error: "native root CI host result conflicts" });
        case "not-found": return notFound(response);
        default: return assertNever(result);
      }
    } catch (error) {
      if (error instanceof ResultHttpError) return sendJson(response, error.status, { error: error.message });
      if (error instanceof UserError) return sendJson(response, 400, { error: error.message });
      throw error;
    }
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") {
    throw new ResultHttpError(415, "content type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBodyBytes) throw new ResultHttpError(413, "request body is too large");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new ResultHttpError(400, "request body must be valid JSON");
    throw error;
  }
}

function authenticatedHost(request: IncomingMessage, config: NativeOrdinaryAuthorityConfig): string | undefined {
  return config.hosts.find((host) => authorized(request,
    { username: host.hostId, password: host.hostToken }))?.hostId;
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
function assertNever(value: never): never { throw new TypeError(`unexpected host result intake: ${JSON.stringify(value)}`); }

class ResultHttpError extends Error {
  readonly name = "ResultHttpError";
  constructor(readonly status: 400 | 413 | 415, message: string) { super(message); }
}
