import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NativeOrdinaryAuthorityConfig, NativeOrdinaryCredential } from "./nativeOrdinaryAuthorityConfig.js";
import {
  NativeRootAdmissionRequestError,
  parseNativeRootAdmissionDiscoveryRequest
} from "./nativeRootAdmissionModel.js";
import type { NativeRootAdmissionStore } from "./nativeRootAdmissionStore.js";
import { createNativeRootAdmissionResponse } from "./nativeRootAdmissionResponse.js";
import { sqliteUnavailable } from "./nativeSqliteAvailability.js";

const maximumBodyBytes = 4 * 1024;
const discoveryRoute = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/root\/native-root-admission\/discover$/;

export function createNativeRootAdmissionReadHandler(input: {
  readonly config: NativeOrdinaryAuthorityConfig;
  readonly generationId: string;
  readonly store: NativeRootAdmissionStore;
  readonly active: () => boolean;
}): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
  return async (request, response, url) => {
    if (url.search !== "") return false;
    if (request.method === "GET" && url.pathname === "/v1/native-root-admission/identity") {
      if (authorized(request, input.config.credentials.registrar)) {
        return send(response, 200, { schemaVersion: 1, serviceId: input.config.serviceId,
          servingGenerationId: input.generationId, role: "native-root-admission-registrar",
          scope: ["imported-root-admission:write", "imported-root-admission:revoke"] });
      }
      if (authorized(request, input.config.credentials.query)) {
        return send(response, 200, { schemaVersion: 1, serviceId: input.config.serviceId,
          servingGenerationId: input.generationId, role: "native-root-admission-reader",
          scope: ["imported-root-admission:read"] });
      }
      return send(response, 404, { error: "not found" });
    }
    const projectId = request.method === "POST" ? discoveryRoute.exec(url.pathname)?.[1] : undefined;
    if (projectId === undefined) return false;
    if (!authorized(request, input.config.credentials.query)) {
      const known = [input.config.credentials.registrar, input.config.credentials.webhook,
        input.config.nativeGit.identity, input.config.nativeGit.attemptIssuer,
        input.config.nativeGit.resultReporter,
        ...input.config.hosts.map((host) => ({ username: host.hostId, password: host.hostToken }))];
      return known.some((credential) => authorized(request, credential))
        ? send(response, 403, { error: "forbidden" }) : send(response, 401, { error: "unauthorized" });
    }
    if (!input.active()) {
      return send(response, 503, { error: "native root admission requires exact generation activation" });
    }
    let body: unknown;
    try {
      body = await readJson(request);
    } catch (error) {
      if (error instanceof DiscoveryHttpError) return send(response, error.status, { error: error.message });
      throw error;
    }
    const selector = parseNativeRootAdmissionDiscoveryRequest(body);
    if (selector.generationId !== input.generationId) {
      return send(response, 409, { error: "native root admission generation is stale" });
    }
    let admission: ReturnType<NativeRootAdmissionStore["discover"]>;
    try {
      admission = input.store.discover(projectId);
    } catch (error) {
      if (sqliteUnavailable(error)) return send(response, 503, { error: "native root admission is unavailable" });
      throw error;
    }
    if (admission === undefined) return send(response, 404, { error: "not found" });
    return send(response, 200, createNativeRootAdmissionResponse({ serviceId: input.config.serviceId,
      generationId: input.generationId, requestId: selector.requestId, admission }));
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") {
    throw new DiscoveryHttpError(415, "content type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBodyBytes) throw new DiscoveryHttpError(413, "request body is too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new NativeRootAdmissionRequestError("request body must be valid JSON");
    throw error;
  }
}

function authorized(request: IncomingMessage, credential: NativeOrdinaryCredential): boolean {
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function send(response: ServerResponse, status: number, body: unknown): true {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
  return true;
}

class DiscoveryHttpError extends Error {
  readonly name = "DiscoveryHttpError";
  constructor(readonly status: 413 | 415, message: string) { super(message); }
}
