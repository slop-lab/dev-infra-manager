import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpRequest,
  NativeGitAdmissionHttpResponse
} from "./nativeGitAdmissionSource.js";

const maximumResponseBytes = 64 * 1024;
const requestTimeoutMilliseconds = 5_000;

export type NativeRootCiHostPreparedRequest = {
  readonly requestId: string;
  readonly body: string;
};

export class NativeRootCiHostClientError extends Error {
  readonly name: string = "NativeRootCiHostClientError";
}

export class NativeRootCiHostRejectedError extends NativeRootCiHostClientError {
  override readonly name = "NativeRootCiHostRejectedError";
  constructor(readonly statusCode: number) {
    super(`native root CI host request was rejected with HTTP ${statusCode}`);
  }
}

export function prepared<T extends { readonly requestId: string }>(request: T): NativeRootCiHostPreparedRequest {
  return { requestId: request.requestId, body: JSON.stringify(request) };
}

export function parsePrepared<T>(
  request: NativeRootCiHostPreparedRequest,
  parser: (value: unknown) => T
): T {
  let value: unknown;
  try { value = JSON.parse(request.body); }
  catch (error) {
    if (error instanceof SyntaxError) {
      throw new NativeRootCiHostClientError("prepared native root CI request is not JSON", { cause: error });
    }
    throw error;
  }
  const parsed = parser(value);
  if (typeof parsed !== "object" || parsed === null
    || Reflect.get(parsed, "requestId") !== request.requestId) {
    throw new NativeRootCiHostClientError("prepared native root CI request ID is inconsistent");
  }
  return parsed;
}

export async function sendJson(
  client: NativeGitAdmissionHttpClient,
  endpoint: string,
  authorization: string,
  path: string,
  body: string,
  signal: AbortSignal,
  acceptedStatuses: readonly number[]
): Promise<{ readonly statusCode: number; readonly body: unknown }> {
  const response = await send(client, {
    endpoint, authorization, path, method: "POST", body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMilliseconds)])
  });
  if (!acceptedStatuses.includes(response.statusCode)) {
    throw new NativeRootCiHostRejectedError(response.statusCode);
  }
  if (response.statusCode === 204) {
    if (response.body.length !== 0 || response.contentType !== undefined || response.cacheControl !== "no-store") {
      throw new NativeRootCiHostClientError("native root CI empty response contract is invalid");
    }
    return { statusCode: 204, body: undefined };
  }
  return { statusCode: response.statusCode, body: parseJson(response) };
}

export async function sendEmpty(
  client: NativeGitAdmissionHttpClient,
  endpoint: string,
  authorization: string,
  path: string,
  body: string,
  signal: AbortSignal
): Promise<void> {
  const response = await send(client, {
    endpoint, authorization, path, method: "POST", body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMilliseconds)])
  });
  if (response.statusCode !== 204) throw new NativeRootCiHostRejectedError(response.statusCode);
  if (response.body.length !== 0 || response.contentType !== undefined || response.cacheControl !== "no-store") {
    throw new NativeRootCiHostClientError("native root CI empty response contract is invalid");
  }
}

export async function sendGet(
  client: NativeGitAdmissionHttpClient,
  endpoint: string,
  authorization: string,
  path: string,
  signal: AbortSignal
): Promise<unknown> {
  const response = await send(client, {
    endpoint, authorization, path, method: "GET",
    signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMilliseconds)])
  });
  if (response.statusCode !== 200) throw new NativeRootCiHostRejectedError(response.statusCode);
  return parseJson(response);
}

function parseJson(response: NativeGitAdmissionHttpResponse): unknown {
  if (response.contentType !== "application/json" || response.cacheControl !== "no-store"
    || response.body.length > maximumResponseBytes) {
    throw new NativeRootCiHostClientError("native root CI response contract is invalid");
  }
  try { return JSON.parse(response.body.toString("utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) {
      throw new NativeRootCiHostClientError("native root CI response is not JSON", { cause: error });
    }
    throw error;
  }
}

async function send(
  client: NativeGitAdmissionHttpClient,
  request: NativeGitAdmissionHttpRequest
): Promise<NativeGitAdmissionHttpResponse> {
  try { return await client.request(request); }
  catch (error) {
    throw new NativeRootCiHostClientError("native root CI host request failed", { cause: error });
  }
}

export function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new NativeRootCiHostClientError("native root CI response fields are invalid");
  }
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)]));
}
