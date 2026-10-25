import { localLeaseExpiry } from "./leaseLifetime.js";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpResponse
} from "@slop-lab/dim-contracts-git/http";
import {
  loadNativeGitWorkspaceWriteIssuerConnection,
  parseNativeGitWorkspaceWriteIssuerConnection,
  type NativeGitWorkspaceWriteIssuerConnection
} from "./nativeGitWorkspaceWriteIssuerConnection.js";

const maximumResponseBytes = 64 * 1024;
const requestTimeoutMilliseconds = 35_000;
const leaseFields = [
  "schemaVersion", "serviceId", "projectId", "repositoryId", "generationId", "workspaceId",
  "username", "password", "issuedAt", "expiresAt", "preIssueMilliseconds"
] as const;

export type NativeGitWorkspaceWriteLeaseRequest = {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
};

export type NativeGitWorkspaceWriteLease = {
  readonly schemaVersion: 2;
  readonly serviceId: "native-main";
  readonly projectId: string;
  readonly repositoryId: string;
  readonly generationId: string;
  readonly workspaceId: string;
  readonly username: string;
  readonly password: string;
  /** Host-local conservative reuse deadline; the issuer enforces actual expiry. */
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
  httpClient: NativeGitAdmissionHttpClient = createNodeNativeGitAdmissionHttpClient(),
  now: () => number = Date.now
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
      const started = performance.now();
      let response: NativeGitAdmissionHttpResponse;
      try {
        response = await httpClient.request({
          endpoint: connection.endpoint,
          method: "POST",
          path: `/v1/projects/${request.projectId}/repositories/${request.repositoryId}/workspace-write-leases`,
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
      const value = parseResponse(response);
      const receivedAt = now(), elapsed = performance.now() - started;
      return parseLease(value, connection, request, receivedAt, elapsed);
    }
  };
}

function parseRequest(input: NativeGitWorkspaceWriteLeaseRequest): NativeGitWorkspaceWriteLeaseRequest {
  const request = exactRecord(input, ["projectId", "repositoryId", "workspaceId"]);

  return {
    projectId: projectIdentifier(request.projectId),
    repositoryId: projectIdentifier(request.repositoryId),
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
  receivedAt: number,
  elapsed: number
): NativeGitWorkspaceWriteLease {
  const lease = exactRecord(value, leaseFields);
  if (lease.schemaVersion !== 2 || lease.serviceId !== connection.serviceId
    || lease.projectId !== request.projectId || lease.repositoryId !== request.repositoryId
    || lease.generationId !== connection.generationId || lease.workspaceId !== request.workspaceId) invalid();
  const expiresAt = localLeaseExpiry({ issuedAt: lease.issuedAt, expiresAt: lease.expiresAt, elapsed,
    preIssueMilliseconds: lease.preIssueMilliseconds, receivedAt });
  if (expiresAt === undefined) throw new NativeGitWorkspaceWriteIssuerClientError("native Git lease lifetime is invalid or exhausted in transit");
  return {
    schemaVersion: 2,
    serviceId: "native-main",
    projectId: request.projectId,
    repositoryId: request.repositoryId,
    generationId: connection.generationId,
    workspaceId: request.workspaceId,
    username: leaseUsername(lease.username),
    password: leasePassword(lease.password),
    expiresAt
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
