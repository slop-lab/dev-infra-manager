import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpRequest,
  NativeGitAdmissionHttpResponse
} from "./nativeGitAdmissionSource.js";
import {
  NativeGitAttemptIssuerRejectedError,
  NativeGitAttemptIssuerUnavailableError
} from "./nativeGitAttemptIssuerErrors.js";

const maximumResponseBytes = 64 * 1024;
const rejectionStatuses = [400, 401, 403, 404, 409] as const;

export async function requestAttemptIssuerJson(
  client: NativeGitAdmissionHttpClient,
  input: NativeGitAdmissionHttpRequest,
  successStatuses: readonly number[]
): Promise<{ readonly statusCode: number; readonly body: unknown }> {
  let response: NativeGitAdmissionHttpResponse;
  try {
    response = await client.request(input);
  } catch (error) {
    throw new NativeGitAttemptIssuerUnavailableError({ cause: error });
  }
  if (rejectionStatuses.some((status) => status === response.statusCode)) {
    throw new NativeGitAttemptIssuerRejectedError(response.statusCode);
  }
  if (!successStatuses.includes(response.statusCode) || response.contentType !== "application/json; charset=utf-8"
    || response.cacheControl !== "no-store" || response.body.length > maximumResponseBytes) {
    throw new NativeGitAttemptIssuerUnavailableError();
  }
  try {
    return { statusCode: response.statusCode, body: JSON.parse(response.body.toString("utf8")) };
  } catch (error) {
    if (error instanceof SyntaxError) throw new NativeGitAttemptIssuerUnavailableError({ cause: error });
    throw error;
  }
}

export function exactAttemptIssuerEnvelope(
  value: unknown,
  keys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => Reflect.get(value, key) === undefined)) {
    throw new NativeGitAttemptIssuerUnavailableError();
  }
  return Object.fromEntries(keys.map((key) => [key, Reflect.get(value, key)]));
}

export function assertAttemptIssuerEnvelope(
  envelope: Readonly<Record<string, unknown>>,
  serviceId: "native-main",
  generationId: string
): void {
  if (envelope.schemaVersion !== 1 || envelope.serviceId !== serviceId
    || envelope.servingGenerationId !== generationId) {
    throw new NativeGitAttemptIssuerUnavailableError();
  }
}
