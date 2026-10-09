import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const maximumBodyBytes = 4 * 1024;

export function parseActivationGeneration(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 2
    || Reflect.get(value, "schemaVersion") !== 1 || typeof Reflect.get(value, "generationId") !== "string"
    || !/^[0-9a-f]{64}$/.test(Reflect.get(value, "generationId"))) {
    throw new NativeGitBundleHttpError("activation request is invalid");
  }
  return Reflect.get(value, "generationId");
}

export async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") {
    throw new NativeGitBundleHttpError("content type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBodyBytes) throw new NativeGitBundleHttpError("request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new NativeGitBundleHttpError("request body must be valid JSON", { cause: error });
    throw error;
  }
}

export function isNativeGitBusinessRequest(method: string | undefined, path: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE"
    || path.startsWith("/v1/projects/") || path.includes(".git/");
}

export function bearerAuthorized(request: IncomingMessage, token: string): boolean {
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function assertBundleToken(value: string, label: string): void {
  const decoded = Buffer.from(value, "base64url");
  if (!/^[A-Za-z0-9_-]+$/.test(value) || decoded.length < 32 || decoded.toString("base64url") !== value) {
    throw new NativeGitBundleHttpError(`native Git ${label} token is invalid`);
  }
}

export function assertGenerationId(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new NativeGitBundleHttpError("native Git startup generation is invalid");
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export function sendEmpty(
  response: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>> = {}
): void {
  response.writeHead(status, { "cache-control": "no-store", ...headers }).end();
}

export function sendNotFound(response: ServerResponse): void {
  sendJson(response, 404, { error: "not found" });
}

export class NativeGitBundleHttpError extends Error {
  readonly name = "NativeGitBundleHttpError";
}
