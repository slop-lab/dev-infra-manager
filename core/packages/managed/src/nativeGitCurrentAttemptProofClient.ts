import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { UserError } from "@slop-lab/dim-core";
import type { NativeGitAdmissionHttpClient } from "./nativeGitAdmissionSource.js";
import {
  NativeAdmissionSourceRejectedError,
  NativeAdmissionSourceUnavailableError
} from "./nativeGitAdmissionSource.js";
import { parseNativeJobAttemptIssuance, type NativeJobAttemptIssuance } from "./nativeGitAttemptIssuerModel.js";

const maximumResponseBytes = 64 * 1024;
const requestTimeoutMilliseconds = 5_000;

type CurrentAttemptProofOptions = {
  readonly endpoint: "http://native-git:8080";
  readonly serviceId: "native-main";
  readonly generationId: string;
  readonly identity: { readonly username: string; readonly password: string };
  readonly httpClient: NativeGitAdmissionHttpClient;
};

export interface NativeGitCurrentAttemptProofClient {
  assertCurrent(input: NativeJobAttemptIssuance): Promise<NativeJobAttemptIssuance>;
}

export function createNativeGitCurrentAttemptProofClient(
  options: CurrentAttemptProofOptions
): NativeGitCurrentAttemptProofClient {
  const authorization = `Basic ${Buffer.from(
    `${options.identity.username}:${options.identity.password}`, "utf8"
  ).toString("base64")}`;
  let attestation: Promise<void> | undefined;
  return {
    async assertCurrent(input) {
      const signal = AbortSignal.timeout(requestTimeoutMilliseconds);
      if (attestation === undefined) attestation = attest(signal);
      try { await attestation; }
      catch (error) { attestation = undefined; throw error; }
      const requestId = randomUUID();
      const response = await request({ method: "POST",
        path: `/v1/projects/${input.descriptor.projectId}/repositories/root/native-ordinary-attempt-proof/current-attempt`,
        body: JSON.stringify({ schemaVersion: 1, requestId, reviewId: input.reviewId,
          executionKind: "ordinary-sysbox", jobName: input.descriptor.jobName, attemptId: input.attemptId }), signal });
      const envelope = exactRecord(response, ["schemaVersion", "serviceId", "requestId", "servingGenerationId",
        "projectId", "repositoryId", "assignment"]);
      if (envelope.schemaVersion !== 1 || envelope.serviceId !== options.serviceId || envelope.requestId !== requestId
        || envelope.servingGenerationId !== options.generationId || envelope.projectId !== input.descriptor.projectId
        || envelope.repositoryId !== "root") unavailable();
      const assignment = parse(() => parseNativeJobAttemptIssuance(envelope.assignment));
      if (!isDeepStrictEqual(assignment, input)) throw new NativeAdmissionSourceRejectedError();
      return assignment;
    }
  };

  async function attest(signal: AbortSignal): Promise<void> {
    const response = await request({ method: "GET", path: "/v1/native-ordinary-attempt-proof/identity", signal });
    const identity = exactRecord(response, ["schemaVersion", "serviceId", "role", "scope", "generationId"]);
    if (identity.schemaVersion !== 1 || identity.serviceId !== options.serviceId
      || identity.role !== "native-ordinary-attempt-proof-reader"
      || !isDeepStrictEqual(identity.scope, ["ordinary-current-attempt:read"])
      || identity.generationId !== options.generationId) unavailable();
  }

  async function request(input: { readonly method: "GET" | "POST"; readonly path: string;
    readonly body?: string; readonly signal: AbortSignal }): Promise<unknown> {
    let response;
    try {
      response = await options.httpClient.request({ endpoint: options.endpoint, method: input.method,
        path: input.path, authorization, generationId: options.generationId,
        ...(input.body === undefined ? {} : { body: input.body }), signal: input.signal });
    } catch (error) {
      throw new NativeAdmissionSourceUnavailableError({ cause: error });
    }
    if (response.statusCode === 404 || response.statusCode === 409) throw new NativeAdmissionSourceRejectedError();
    if (response.statusCode !== 200 || response.contentType !== "application/json; charset=utf-8"
      || response.cacheControl !== "no-store" || response.body.length > maximumResponseBytes) unavailable();
    try { return JSON.parse(response.body.toString("utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) throw new NativeAdmissionSourceUnavailableError({ cause: error });
      throw error;
    }
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) unavailable();
  return Object.fromEntries(keys.map((key) => [key, Reflect.get(value, key)]));
}
function parse<Result>(operation: () => Result): Result {
  try { return operation(); }
  catch (error) {
    if (error instanceof UserError) throw new NativeAdmissionSourceUnavailableError({ cause: error });
    throw error;
  }
}
function unavailable(): never { throw new NativeAdmissionSourceUnavailableError(); }
