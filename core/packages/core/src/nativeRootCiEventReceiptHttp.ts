import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sqliteUnavailable } from "./nativeSqliteAvailability.js";
import type { NativeOrdinaryAuthorityConfig, NativeOrdinaryCredential } from "./nativeOrdinaryAuthorityConfig.js";
import {
  NativeRootCiEventReceiptRequestError,
  parseNativeRootCiEventReceiptRequest
} from "./nativeRootCiEventReceiptModel.js";
import {
  NativeRootCiEventReceiptStore,
  type ReceiptPreflight
} from "./nativeRootCiEventReceiptStore.js";
import {
  NativeRootCiProofRejectedError,
  NativeRootCiProofUnavailableError,
  type NativeRootCiProofClient
} from "./nativeRootCiProofClient.js";

const maximumBodyBytes = 64 * 1024;

export type NativeRootCiEventReceiptHttpOptions = {
  readonly config: NativeOrdinaryAuthorityConfig;
  readonly expectedGenerationId: string;
  readonly store: NativeRootCiEventReceiptStore;
  readonly proofClient: NativeRootCiProofClient;
  readonly activated: () => boolean;
  readonly activationBound: () => boolean;
};

export function createNativeRootCiEventReceiptHandler(options: NativeRootCiEventReceiptHttpOptions) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== "/v1/native-root-ci-events") return false;
    if (request.method !== "POST" || url.search !== "") return notFound(response);
    const authentication = authenticate(request, options.config);
    if (authentication === "invalid") return sendJson(response, 401, { error: "unauthorized" });
    if (authentication === "wrong-role") return sendJson(response, 403, { error: "forbidden" });
    if (!options.activated() || !options.activationBound()) {
      return sendJson(response, 503, { error: "native root CI event intake requires exact generation activation" });
    }
    try {
      const input = parseNativeRootCiEventReceiptRequest(await readJson(request));
      if (input.generationId !== options.expectedGenerationId) {
        return sendJson(response, 409, { error: "native root CI event generation is stale" });
      }
      const preflight = options.store.preflight(input);
      if (preflight.kind !== "ready") return sendResult(response, input, preflight);
      const admission = preflight.admission.proof;
      const proof = await options.proofClient.readOrdinaryReviewEvent({ projectId: input.event.projectId,
        importNonce: admission.currentRoot.importNonce, policyDigest: admission.currentRoot.policyDigest,
        eventId: input.event.eventId, reviewId: input.event.reviewId,
        executionKind: "ordinary-sysbox", jobName: input.event.jobName }, AbortSignal.timeout(5_000));
      return sendResult(response, input, options.store.commit(input, proof));
    } catch (error) {
      if (error instanceof NativeRootCiEventReceiptRequestError) {
        return sendJson(response, 400, { error: error.message });
      }
      if (error instanceof ReceiptHttpError) return sendJson(response, error.status, { error: error.message });
      if (error instanceof NativeRootCiProofRejectedError) {
        return sendJson(response, error.statusCode, { error: error.message });
      }
      if (error instanceof NativeRootCiProofUnavailableError || sqliteUnavailable(error)) {
        return sendJson(response, 503, { error: "native root CI event receipt durability is unavailable" });
      }
      return sendJson(response, 500, { error: "internal server error" });
    }
  };
}

function sendResult(response: ServerResponse, input: ReturnType<typeof parseNativeRootCiEventReceiptRequest>,
  result: Exclude<ReceiptPreflight, { readonly kind: "ready" }>): true {
  switch (result.kind) {
    case "replay": return sendJson(response, 202, { schemaVersion: 1, generationId: input.generationId,
      admissionGeneration: input.admissionGeneration, eventId: input.event.eventId, recorded: true });
    case "conflict": return sendJson(response, 409, { error: "native root CI event receipt conflicts" });
    case "not-found": return sendJson(response, 404, { error: "not found" });
    case "full": return sendJson(response, 429, { error: "native root CI event receipt capacity is full" });
    default: return assertNever(result);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw new ReceiptHttpError(415, "content type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBodyBytes) throw new ReceiptHttpError(413, "request body is too large");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new NativeRootCiEventReceiptRequestError();
    throw error;
  }
}

function authenticate(request: IncomingMessage, config: NativeOrdinaryAuthorityConfig): "authorized" | "invalid" | "wrong-role" {
  if (authorized(request, config.credentials.webhook)) return "authorized";
  const known = [config.credentials.registrar, config.credentials.query, config.nativeGit.identity,
    config.nativeGit.attemptIssuer, config.nativeGit.resultReporter,
    ...config.hosts.map((host) => ({ username: host.hostId, password: host.hostToken }))];
  return known.some((credential) => authorized(request, credential)) ? "wrong-role" : "invalid";
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
function assertNever(value: never): never { throw new TypeError(`unexpected receipt result: ${JSON.stringify(value)}`); }
class ReceiptHttpError extends Error {
  readonly name = "ReceiptHttpError";
  constructor(readonly status: 413 | 415, message: string) { super(message); }
}
