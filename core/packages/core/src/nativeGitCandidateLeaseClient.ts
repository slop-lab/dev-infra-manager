import type { NativeGitAdmissionHttpClient } from "./nativeGitAdmissionSource.js";
import type { NativeCandidateLease } from "./nativeCandidateLease.js";

export async function requestNativeGitCandidateLease(input: {
  readonly endpoint: string;
  readonly credential: { readonly username: string; readonly password: string };
  readonly selector: Readonly<Record<string, unknown>>;
  readonly httpClient: NativeGitAdmissionHttpClient;
  readonly signal: AbortSignal;
}): Promise<NativeCandidateLease> {
  const response = await input.httpClient.request({ endpoint: input.endpoint, method: "POST",
    path: "/v1/candidate-read-leases", authorization: `Basic ${Buffer.from(
      `${input.credential.username}:${input.credential.password}`, "utf8").toString("base64")}`,
    body: JSON.stringify(input.selector), signal: input.signal });
  if (response.statusCode !== 201 || response.contentType !== "application/json"
    || response.cacheControl !== "no-store") invalid();
  let value: unknown;
  try { value = JSON.parse(response.body.toString("utf8")); }
  catch { return invalid(); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const requestId = Reflect.get(value, "requestId"); const serviceId = Reflect.get(value, "serviceId");
  const username = Reflect.get(value, "username"); const password = Reflect.get(value, "password");
  const expiresAt = Reflect.get(value, "expiresAt");
  if (requestId !== input.selector.requestId || serviceId !== "native-main"
    || typeof username !== "string" || typeof password !== "string" || typeof expiresAt !== "number") invalid();
  return { username, password, expiresAt };
}

function invalid(): never { throw new NativeGitCandidateLeaseClientError("candidate lease response is invalid"); }
export class NativeGitCandidateLeaseClientError extends Error { readonly name = "NativeGitCandidateLeaseClientError"; }
