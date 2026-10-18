import { createNodeNativeGitAdmissionHttpClient } from "./nativeGitAdmissionHttpClient.js";
import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpRequest,
  NativeGitAdmissionHttpResponse
} from "./nativeGitAdmissionSource.js";
import {
  loadNativeGitProjectRegistrarConnection,
  parseNativeGitProjectRegistrarConnection,
  type NativeGitProjectRegistrarConnection
} from "./nativeGitProjectRegistrarConnection.js";

const maximumResponseBytes = 64 * 1024;
const requestTimeoutMilliseconds = 5_000;

export type NativeGitProjectPreparation = {
  readonly serviceId: "native-main";
  readonly projectId: string;
  readonly rootRepositoryId: "root";
};

export type NativeGitProjectPreparationResult = {
  readonly schemaVersion: 1;
  readonly generationId: string;
  readonly hostId: string;
  readonly preparation: {
    readonly serviceId: "native-main";
    readonly projectId: string;
    readonly rootRepositoryId: "root";
    readonly state: "root-prepared";
  };
};

export interface NativeGitProjectRegistrarClient {
  readonly hostId: string;
  readonly generationId: string;
  attest(signal: AbortSignal): Promise<void>;
  prepare(
    preparation: NativeGitProjectPreparation,
    signal: AbortSignal
  ): Promise<NativeGitProjectPreparationResult>;
}

export async function createNodeNativeGitProjectRegistrarClient(
  connectionFile: string
): Promise<NativeGitProjectRegistrarClient> {
  const connection = await loadNativeGitProjectRegistrarConnection(connectionFile);
  return createNativeGitProjectRegistrarClient(connection, createNodeNativeGitAdmissionHttpClient());
}

export function createNativeGitProjectRegistrarClient(
  input: NativeGitProjectRegistrarConnection,
  httpClient: NativeGitAdmissionHttpClient
): NativeGitProjectRegistrarClient {
  const connection = parseNativeGitProjectRegistrarConnection(input);
  const authorization = `Basic ${Buffer.from(
    `${connection.credential.username}:${connection.credential.password}`,
    "utf8"
  ).toString("base64")}`;
  return {
    hostId: connection.hostId,
    generationId: connection.generationId,
    async attest(signal) {
      await attestIdentity(connection, authorization, httpClient, signal);
    },
    async prepare(input, signal) {
      const preparation = parsePreparation(input);
      await attestIdentity(connection, authorization, httpClient, signal);
      const response = await requestJson(httpClient, request(connection, authorization, {
        method: "POST",
        path: "/v1/operator-project-preparations",
        body: JSON.stringify({
          schemaVersion: 1,
          generationId: connection.generationId,
          preparation
        }),
        signal
      }));
      return parsePreparationResponse(response, connection, preparation);
    }
  };
}

export class NativeGitProjectRegistrarClientError extends Error {
  readonly name: string = "NativeGitProjectRegistrarClientError";
}

export class NativeGitProjectRegistrarRejectedError extends NativeGitProjectRegistrarClientError {
  override readonly name = "NativeGitProjectRegistrarRejectedError";

  constructor(readonly statusCode: number) {
    super(`native Git rejected the Project registrar request with HTTP ${statusCode}`);
  }
}

async function attestIdentity(
  connection: NativeGitProjectRegistrarConnection,
  authorization: string,
  httpClient: NativeGitAdmissionHttpClient,
  signal: AbortSignal
): Promise<void> {
  const identity = exactRecord(await requestJson(httpClient, request(connection, authorization, {
    method: "GET", path: "/v1/operator-project-registrar-identity", signal
  })), ["schemaVersion", "serviceId", "role", "hostId"]);
  if (identity.schemaVersion !== 1 || identity.serviceId !== connection.serviceId
    || identity.role !== "operator-project-registrar" || identity.hostId !== connection.hostId) {
    throw new NativeGitProjectRegistrarClientError("native Git Project registrar identity does not match configuration");
  }
}

type RequestInput = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: string;
  readonly signal: AbortSignal;
};

function request(
  connection: NativeGitProjectRegistrarConnection,
  authorization: string,
  input: RequestInput
): NativeGitAdmissionHttpRequest {
  return {
    endpoint: connection.endpoint,
    method: input.method,
    path: input.path,
    authorization,
    ...(input.body === undefined ? {} : { body: input.body }),
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(requestTimeoutMilliseconds)])
  };
}

async function requestJson(
  httpClient: NativeGitAdmissionHttpClient,
  input: NativeGitAdmissionHttpRequest
): Promise<unknown> {
  let response: NativeGitAdmissionHttpResponse;
  try {
    response = await httpClient.request(input);
  } catch {
    throw new NativeGitProjectRegistrarClientError("native Git Project registrar request failed");
  }
  if (response.statusCode !== 200) throw new NativeGitProjectRegistrarRejectedError(response.statusCode);
  if (response.contentType !== "application/json" || response.cacheControl !== "no-store"
    || response.body.length > maximumResponseBytes) {
    throw new NativeGitProjectRegistrarClientError("native Git Project registrar response contract is invalid");
  }
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new NativeGitProjectRegistrarClientError("native Git Project registrar response is not valid JSON");
    }
    throw error;
  }
}

function parsePreparation(input: NativeGitProjectPreparation): NativeGitProjectPreparation {
  const root = exactRecord(input, ["serviceId", "projectId", "rootRepositoryId"]);
  if (root.serviceId !== "native-main" || root.rootRepositoryId !== "root") invalidResponse();
  return {
    serviceId: "native-main",
    projectId: projectIdentifier(root.projectId),
    rootRepositoryId: "root"
  };
}

function parsePreparationResponse(
  value: unknown,
  connection: NativeGitProjectRegistrarConnection,
  requested: NativeGitProjectPreparation
): NativeGitProjectPreparationResult {
  const root = exactRecord(value, ["schemaVersion", "generationId", "hostId", "preparation"]);
  const preparation = exactRecord(root.preparation, [
    "serviceId", "projectId", "rootRepositoryId", "state"
  ]);
  if (root.schemaVersion !== 1 || root.generationId !== connection.generationId || root.hostId !== connection.hostId
    || preparation.serviceId !== requested.serviceId || preparation.projectId !== requested.projectId
    || preparation.rootRepositoryId !== requested.rootRepositoryId
    || preparation.state !== "root-prepared") invalidResponse();
  return {
    schemaVersion: 1,
    generationId: connection.generationId,
    hostId: connection.hostId,
    preparation: {
      serviceId: "native-main",
      projectId: requested.projectId,
      rootRepositoryId: "root",
      state: "root-prepared"
    }
  };
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    return invalidResponse();
  }
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)]));
}

function projectIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) invalidResponse();
  return value;
}

function invalidResponse(): never {
  throw new NativeGitProjectRegistrarClientError("native Git Project registrar data is invalid");
}
