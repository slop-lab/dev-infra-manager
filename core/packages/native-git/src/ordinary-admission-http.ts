import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  AdmissionVerifier,
  AdmittedExecution,
  CurrentAttemptEvidence
} from "./admission-verifier.js";
import {
  admissionVerificationTimeoutMilliseconds,
  withinAdmissionVerificationDeadline
} from "./admission-verifier.js";
import { candidateOrdinaryExecutionDescriptorSchema } from "./candidate-execution-schema.js";

const maximumResponseBytes = 64 * 1024;
const queryScope = ["admission:read", "attempt:read"] as const;
const admissionReaderScope = ["imported-root-admission:read"] as const;

const identityResponseSchema = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.string(),
  role: z.literal("native-query"),
  scope: z.tuple([z.literal(queryScope[0]), z.literal(queryScope[1])]).readonly()
}).strict().readonly();

const admissionReaderIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.string(),
  servingGenerationId: z.string().regex(/^[0-9a-f]{64}$/),
  role: z.literal("native-root-admission-reader"),
  scope: z.tuple([z.literal(admissionReaderScope[0])]).readonly()
}).strict().readonly();

const admittedResponseSchema = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.string(),
  requestId: z.string().uuid(),
  authorized: z.literal(true),
  descriptor: candidateOrdinaryExecutionDescriptorSchema,
  descriptorDigest: z.string(),
  hostId: z.string(),
  capacity: z.string()
}).strict().readonly();

const currentAttemptResponseSchema = z.object({
  schemaVersion: z.literal(1),
  serviceId: z.string(),
  requestId: z.string().uuid(),
  authorized: z.literal(true),
  reviewId: z.string(),
  attemptId: z.string(),
  descriptorDigest: z.string(),
  admissionGeneration: z.string(),
  hostId: z.string(),
  capacity: z.string()
}).strict().readonly();

export type AdmissionVerifierHttpRequest = {
  readonly endpoint: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly authorization: string;
  readonly body?: string;
  readonly signal: AbortSignal;
};

export type AdmissionVerifierHttpResponse = {
  readonly statusCode: number;
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
  readonly body: Buffer;
};

export interface AdmissionVerifierHttpClient {
  request(input: AdmissionVerifierHttpRequest): Promise<AdmissionVerifierHttpResponse>;
}

export type OrdinaryAdmissionVerifierOptions = {
  readonly config: {
    readonly endpoint: "http://ordinary-ci:8080";
    readonly serviceId: "ordinary-main";
    readonly query: { readonly username: string; readonly password: string };
    readonly [key: string]: unknown;
  };
  readonly httpClient: AdmissionVerifierHttpClient;
  readonly timeoutMilliseconds?: number;
};

export async function createOrdinaryAdmissionVerifier(
  options: OrdinaryAdmissionVerifierOptions
): Promise<AdmissionVerifier> {
  const authorization = basicAuthorization(options.config.query.username, options.config.query.password);
  await withinAdmissionVerificationDeadline(async (signal) => {
    const response = await requestJson(options.httpClient, {
      endpoint: options.config.endpoint,
      method: "GET",
      path: "/v1/identity",
      authorization,
      signal
    });
    const identity = parseResponse(identityResponseSchema, response);
    if (identity.serviceId !== options.config.serviceId || !isDeepStrictEqual(identity.scope, queryScope)) {
      throw new OrdinaryAdmissionVerifierError("ordinary CI service identity or query scope did not match");
    }
  }, options.timeoutMilliseconds ?? admissionVerificationTimeoutMilliseconds);

  return {
    async assertAdmitted(input, signal) {
      const expected = {
        schemaVersion: 1,
        serviceId: options.config.serviceId,
        requestId: randomUUID(),
        authorized: true,
        ...input
      } as const;
      const response = await requestJson(options.httpClient, {
        endpoint: options.config.endpoint,
        method: "POST",
        path: "/v1/admission-verifications",
        authorization,
        body: JSON.stringify(withoutServiceResult(expected)),
        signal
      });
      assertExactResponse(admittedResponseSchema, response, expected);
    },
    async assertCurrentAttempt(input, signal) {
      const expected = {
        schemaVersion: 1,
        serviceId: options.config.serviceId,
        requestId: randomUUID(),
        authorized: true,
        ...input
      } as const;
      const response = await requestJson(options.httpClient, {
        endpoint: options.config.endpoint,
        method: "POST",
        path: "/v1/current-attempt-verifications",
        authorization,
        body: JSON.stringify(withoutServiceResult(expected)),
        signal
      });
      assertExactResponse(currentAttemptResponseSchema, response, expected);
    }
  };
}

export async function attestNativeRootAdmissionReader(
  options: OrdinaryAdmissionVerifierOptions,
  generationId: string
): Promise<void> {
  const authorization = basicAuthorization(options.config.query.username, options.config.query.password);
  await withinAdmissionVerificationDeadline(async (signal) => {
    const response = await requestJson(options.httpClient, {
      endpoint: options.config.endpoint,
      method: "GET",
      path: "/v1/native-root-admission/identity",
      authorization,
      signal
    });
    const identity = parseResponse(admissionReaderIdentitySchema, response);
    if (identity.serviceId !== options.config.serviceId || identity.servingGenerationId !== generationId
      || !isDeepStrictEqual(identity.scope, admissionReaderScope)) {
      throw new OrdinaryAdmissionVerifierError("ordinary CI admission reader identity did not match");
    }
  }, options.timeoutMilliseconds ?? admissionVerificationTimeoutMilliseconds);
}

export function createNodeAdmissionVerifierHttpClient(originOverride?: string): AdmissionVerifierHttpClient {
  return {
    request(input) {
      const origin = originOverride ?? input.endpoint;
      return nodeRequest(new URL(input.path, origin), input);
    }
  };
}

function nodeRequest(url: URL, input: AdmissionVerifierHttpRequest): Promise<AdmissionVerifierHttpResponse> {
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : Buffer.from(input.body, "utf8");
    const request = httpRequest(url, {
      method: input.method,
      signal: input.signal,
      headers: {
        Authorization: input.authorization,
        Accept: "application/json",
        ...(body === undefined ? {} : {
          "Content-Type": "application/json",
          "Content-Length": String(body.length)
        })
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maximumResponseBytes) {
          response.destroy(new OrdinaryAdmissionVerifierError("ordinary CI response exceeded the size limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        contentType: response.headers["content-type"],
        cacheControl: response.headers["cache-control"],
        body: Buffer.concat(chunks)
      }));
      response.on("error", reject);
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function requestJson(
  client: AdmissionVerifierHttpClient,
  input: AdmissionVerifierHttpRequest
): Promise<AdmissionVerifierHttpResponse> {
  let response: AdmissionVerifierHttpResponse;
  try {
    response = await client.request(input);
  } catch (error) {
    throw new OrdinaryAdmissionVerifierError("ordinary CI request failed", { cause: error });
  }
  if (response.statusCode !== 200) {
    throw new OrdinaryAdmissionVerifierError(`ordinary CI rejected verification with status ${response.statusCode}`);
  }
  if (response.contentType !== "application/json" || response.cacheControl !== "no-store"
    || response.body.length > maximumResponseBytes) {
    throw new OrdinaryAdmissionVerifierError("ordinary CI returned a malformed response");
  }
  return response;
}

function parseResponse<T>(schema: z.ZodType<T>, response: AdmissionVerifierHttpResponse): T {
  let input: unknown;
  try {
    input = JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new OrdinaryAdmissionVerifierError("ordinary CI returned malformed JSON", { cause: error });
    }
    throw error;
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new OrdinaryAdmissionVerifierError("ordinary CI returned a response outside the verification contract", {
      cause: parsed.error
    });
  }
  return parsed.data;
}

function assertExactResponse<T>(
  schema: z.ZodType<T>,
  response: AdmissionVerifierHttpResponse,
  expected: T
): void {
  if (!isDeepStrictEqual(parseResponse(schema, response), expected)) {
    throw new OrdinaryAdmissionVerifierError("ordinary CI returned a mismatched verification tuple");
  }
}

function withoutServiceResult(input: {
  readonly schemaVersion: 1;
  readonly serviceId: string;
  readonly requestId: string;
  readonly authorized: true;
} & (AdmittedExecution | CurrentAttemptEvidence)): Record<string, unknown> {
  const { serviceId: _serviceId, authorized: _authorized, ...request } = input;
  return request;
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export class OrdinaryAdmissionVerifierError extends Error {
  readonly name = "OrdinaryAdmissionVerifierError";
}
