import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { UserError } from "./errors.js";
import type { NativeOrdinaryCredential } from "./nativeOrdinaryAuthorityConfig.js";
import { NativeRootAdmissionRequestError } from "./nativeRootAdmissionModel.js";
import {
  NativeRootCiProofRejectedError,
  NativeRootCiProofUnavailableError
} from "./nativeRootCiProofClient.js";

const maximumBodyBytes = 4 * 1024;

export async function readNativeRootAdmissionJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") {
    throw new NativeRootAdmissionHttpError(415, "content type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBodyBytes) throw new NativeRootAdmissionHttpError(413, "request body is too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new NativeRootAdmissionRequestError("request body must be valid JSON");
    throw error;
  }
}

export function nativeRootBasicAuthorized(request: IncomingMessage, credential: NativeOrdinaryCredential): boolean {
  return headerAuthorized(request, `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`);
}

export function nativeRootBearerAuthorized(request: IncomingMessage, token: string): boolean {
  return headerAuthorized(request, `Bearer ${token}`);
}

export function sendNativeRootAdmissionError(response: ServerResponse, error: unknown): void {
  if (error instanceof NativeRootCiProofUnavailableError) return sendNativeRootJson(response, 503, { error: error.message });
  if (error instanceof NativeRootCiProofRejectedError) return sendNativeRootJson(response, error.statusCode, { error: error.message });
  if (error instanceof NativeRootAdmissionHttpError) return sendNativeRootJson(response, error.status, { error: error.message });
  if (error instanceof NativeRootAdmissionRequestError || error instanceof UserError) {
    return sendNativeRootJson(response, 400, { error: error.message });
  }
  return sendNativeRootJson(response, 500, { error: "internal server error" });
}

export function sendNativeRootJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export function sendNativeRootNotFound(response: ServerResponse): void {
  sendNativeRootJson(response, 404, { error: "not found" });
}

function headerAuthorized(request: IncomingMessage, expected: string): boolean {
  const actual = Buffer.from(request.headers.authorization ?? "");
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

class NativeRootAdmissionHttpError extends Error {
  readonly name = "NativeRootAdmissionHttpError";

  constructor(readonly status: 413 | 415, message: string) {
    super(message);
  }
}
