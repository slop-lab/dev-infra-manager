import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpRequest,
  NativeGitAdmissionHttpResponse
} from "@slop-lab/dim-contracts-git/http";
import {
  loadNativeGitProjectRegistrarConnection,
  parseNativeGitProjectRegistrarConnection,
  type NativeGitProjectRegistrarConnection
} from "./nativeGitProjectRegistrarConnection.js";

const maximumResponseBytes = 64 * 1024;

export type NativeGitProjectPreparation = {
  readonly serviceId: "native-main";
  readonly projectId: string;
  readonly repositoryId: string;
};

export type NativeGitProjectPreparationResult = {
  readonly schemaVersion: 1;
  readonly generationId: string;
  readonly hostId: string;
  readonly preparation: {
    readonly serviceId: "native-main";
    readonly projectId: string;
    readonly repositoryId: string;
    readonly state: "repository-prepared";
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
      try {
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
      } catch (error) {
        if (error instanceof NativeGitProjectRegistrarUncertainWriteError
          || error instanceof NativeGitProjectRegistrarRejectedError && error.statusCode >= 400 && error.statusCode < 500) throw error;
        throw new NativeGitProjectRegistrarUncertainWriteError(
          "native Git Project preparation acknowledgement is unconfirmed; result is uncertain, inspect current state and retry only the identical preparation intent",
          { cause: error }
        );
      }
    }
  };
}

export class NativeGitProjectRegistrarClientError extends Error {
  readonly name: string = "NativeGitProjectRegistrarClientError";
}

export class NativeGitProjectRegistrarRejectedError extends NativeGitProjectRegistrarClientError {
  override readonly name = "NativeGitProjectRegistrarRejectedError";
  readonly outcome = "rejected";

  constructor(readonly statusCode: number) {
    super(`native Git rejected the Project registrar request with HTTP ${statusCode}`);
  }
}

export class NativeGitProjectRegistrarUncertainWriteError extends NativeGitProjectRegistrarClientError {
  override readonly name = "NativeGitProjectRegistrarUncertainWriteError";
  readonly outcome = "uncertain-write";
}

async function attestIdentity(
  connection: NativeGitProjectRegistrarConnection,
  authorization: string,
  httpClient: NativeGitAdmissionHttpClient,
  signal: AbortSignal
): Promise<void> {
  const identity = exactRecord(await requestJson(httpClient, request(connection, authorization, {
    method: "GET", path: "/v1/operator-project-registrar-identity", signal
  }), "read"), ["schemaVersion", "serviceId", "role", "hostId", "generationId"]);
  if (identity.schemaVersion !== 1 || identity.serviceId !== connection.serviceId
    || identity.role !== "operator-project-registrar" || identity.hostId !== connection.hostId
    || identity.generationId !== connection.generationId) {
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
    signal: input.signal
  };
}

async function requestJson(
  httpClient: NativeGitAdmissionHttpClient,
  input: NativeGitAdmissionHttpRequest,
  operation: "read" | "write" = "write"
): Promise<unknown> {
  let response: NativeGitAdmissionHttpResponse;
  try {
    response = await httpClient.request(input);
  } catch (error) {
    if (operation === "write") {
      throw new NativeGitProjectRegistrarUncertainWriteError(
        "native Git Project preparation result is uncertain after transport loss; retry only the identical preparation intent",
        { cause: error }
      );
    }
    throw new NativeGitProjectRegistrarClientError("native Git Project registrar identity request failed", { cause: error });
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
  const root = exactRecord(input, ["serviceId", "projectId", "repositoryId"]);
  if (root.serviceId !== "native-main") invalidResponse();
  return {
    serviceId: "native-main",
    projectId: projectIdentifier(root.projectId),
    repositoryId: projectIdentifier(root.repositoryId)
  };
}

function parsePreparationResponse(
  value: unknown,
  connection: NativeGitProjectRegistrarConnection,
  requested: NativeGitProjectPreparation
): NativeGitProjectPreparationResult {
  const root = exactRecord(value, ["schemaVersion", "generationId", "hostId", "preparation"]);
  const preparation = exactRecord(root.preparation, [
    "serviceId", "projectId", "repositoryId", "state"
  ]);
  if (root.schemaVersion !== 1 || root.generationId !== connection.generationId || root.hostId !== connection.hostId
    || preparation.serviceId !== requested.serviceId || preparation.projectId !== requested.projectId
    || preparation.repositoryId !== requested.repositoryId
    || preparation.state !== "repository-prepared") invalidResponse();
  return {
    schemaVersion: 1,
    generationId: connection.generationId,
    hostId: connection.hostId,
    preparation: {
      serviceId: "native-main",
      projectId: requested.projectId,
      repositoryId: requested.repositoryId,
      state: "repository-prepared"
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
