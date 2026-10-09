import { createNodeNativeGitAdmissionHttpClient } from "./nativeGitAdmissionHttpClient.js";
import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpResponse
} from "./nativeGitAdmissionSource.js";
import {
  loadNativeGitWorkspaceWriteIssuerConnection,
  parseNativeGitWorkspaceWriteIssuerConnection,
  type NativeGitWorkspaceWriteIssuerConnection
} from "./nativeGitWorkspaceWriteIssuerConnection.js";

const maximumResponseBytes = 64 * 1024;
const requestTimeoutMilliseconds = 5_000;
const maximumLeaseLifetimeMilliseconds = 30_000;
const leaseFields = [
  "schemaVersion", "serviceId", "projectId", "repositoryId", "generationId", "workspaceId",
  "username", "password", "expiresAt"
] as const;

export type NativeGitWorkspaceWriteLeaseRequest = {
  readonly projectId: string;
  readonly repositoryId: "root";
  readonly workspaceId: string;
};

export type NativeGitWorkspaceWriteLease = {
  readonly schemaVersion: 1;
  readonly serviceId: "native-main";
  readonly projectId: string;
  readonly repositoryId: "root";
  readonly generationId: string;
  readonly workspaceId: string;
  readonly username: string;
  readonly password: string;
  readonly expiresAt: number;
};

export interface NativeGitWorkspaceWriteIssuerClient {
  readonly endpoint: string;
  readonly hostId: string;
  readonly generationId: string;
  issueWorkspaceWriteLease(
    request: NativeGitWorkspaceWriteLeaseRequest,
    signal: AbortSignal
  ): Promise<NativeGitWorkspaceWriteLease>;
}

export class NativeGitWorkspaceWriteIssuerClientError extends Error {
  readonly name: string = "NativeGitWorkspaceWriteIssuerClientError";
}

export class NativeGitWorkspaceWriteIssuerRejectedError extends NativeGitWorkspaceWriteIssuerClientError {
  override readonly name = "NativeGitWorkspaceWriteIssuerRejectedError";

  constructor(readonly statusCode: number) {
    super(`native Git rejected the workspace write lease request with HTTP ${statusCode}`);
  }
}

export async function createNodeNativeGitWorkspaceWriteIssuerClient(
  connectionFile: string
): Promise<NativeGitWorkspaceWriteIssuerClient> {
  return createNativeGitWorkspaceWriteIssuerClient(
    await loadNativeGitWorkspaceWriteIssuerConnection(connectionFile),
    createNodeNativeGitAdmissionHttpClient()
  );
}

export function createNativeGitWorkspaceWriteIssuerClient(
  input: NativeGitWorkspaceWriteIssuerConnection,
  httpClient: NativeGitAdmissionHttpClient = createNodeNativeGitAdmissionHttpClient()
): NativeGitWorkspaceWriteIssuerClient {
  const connection = parseNativeGitWorkspaceWriteIssuerConnection(input);
  const authorization = `Basic ${Buffer.from(
    `${connection.credential.username}:${connection.credential.password}`,
    "utf8"
  ).toString("base64")}`;
  return {
    endpoint: connection.endpoint,
    hostId: connection.hostId,
    generationId: connection.generationId,
    async issueWorkspaceWriteLease(input, signal) {
      const request = parseRequest(input);
      let response: NativeGitAdmissionHttpResponse;
      try {
        response = await httpClient.request({
          endpoint: connection.endpoint,
          method: "POST",
          path: `/v1/projects/${request.projectId}/workspace-write-leases`,
          authorization,
          body: JSON.stringify({
            schemaVersion: 1,
            generationId: connection.generationId,
            repositoryId: request.repositoryId,
            workspaceId: request.workspaceId
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMilliseconds)])
        });
      } catch {
        throw new NativeGitWorkspaceWriteIssuerClientError("native Git workspace write lease request failed");
      }
      const receivedAt = Date.now();
      return parseLease(parseResponse(response), connection, request, receivedAt);
    }
  };
}

function parseRequest(input: NativeGitWorkspaceWriteLeaseRequest): NativeGitWorkspaceWriteLeaseRequest {
  const request = exactRecord(input, ["projectId", "repositoryId", "workspaceId"]);
  if (request.repositoryId !== "root") invalid();
  return {
    projectId: projectIdentifier(request.projectId),
    repositoryId: "root",
    workspaceId: workspaceIdentifier(request.workspaceId)
  };
}

function parseResponse(response: NativeGitAdmissionHttpResponse): unknown {
  if (response.statusCode !== 201) throw new NativeGitWorkspaceWriteIssuerRejectedError(response.statusCode);
  if (response.contentType !== "application/json" || response.cacheControl !== "no-store"
    || response.body.length > maximumResponseBytes) invalid();
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) invalid();
    throw error;
  }
}

function parseLease(
  value: unknown,
  connection: NativeGitWorkspaceWriteIssuerConnection,
  request: NativeGitWorkspaceWriteLeaseRequest,
  receivedAt: number
): NativeGitWorkspaceWriteLease {
  const lease = exactRecord(value, leaseFields);
  if (lease.schemaVersion !== 1 || lease.serviceId !== connection.serviceId
    || lease.projectId !== request.projectId || lease.repositoryId !== request.repositoryId
    || lease.generationId !== connection.generationId || lease.workspaceId !== request.workspaceId
    || typeof lease.expiresAt !== "number" || !Number.isSafeInteger(lease.expiresAt)
    || lease.expiresAt <= receivedAt
    || lease.expiresAt > receivedAt + maximumLeaseLifetimeMilliseconds) invalid();
  return {
    schemaVersion: 1,
    serviceId: "native-main",
    projectId: request.projectId,
    repositoryId: "root",
    generationId: connection.generationId,
    workspaceId: request.workspaceId,
    username: leaseUsername(lease.username),
    password: leasePassword(lease.password),
    expiresAt: lease.expiresAt
  };
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))) invalid();
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) invalid();
  return value;
}

function workspaceIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) invalid();
  return value;
}

function leaseUsername(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("workspace-write-")) invalid();
  const encoded = value.slice("workspace-write-".length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== 18 || decoded.toString("base64url") !== encoded) invalid();
  return value;
}

function leasePassword(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) invalid();
  return value;
}

function invalid(): never {
  throw new NativeGitWorkspaceWriteIssuerClientError(
    "native Git workspace write lease data does not match the request"
  );
}
