import { createNodeNativeGitAdmissionHttpClient } from "./nativeGitAdmissionHttpClient.js";
import type {
  NativeGitAdmissionHttpClient,
  NativeGitAdmissionHttpResponse
} from "./nativeGitAdmissionSource.js";
import {
  loadNativeGitRootReadIssuerConnection,
  parseNativeGitRootReadIssuerConnection,
  type NativeGitRootReadIssuerConnection
} from "./nativeGitRootReadIssuerConnection.js";

const maximumResponseBytes = 64 * 1024;
const requestTimeoutMilliseconds = 5_000;
const maximumLeaseLifetimeMilliseconds = 30_000;
const leaseFields = [
  "schemaVersion", "serviceId", "projectId", "rootRepositoryId", "generationId",
  "username", "password", "expiresAt"
] as const;

export type NativeGitRootReadLease = {
  readonly schemaVersion: 1;
  readonly serviceId: "native-main";
  readonly projectId: string;
  readonly rootRepositoryId: "root";
  readonly generationId: string;
  readonly username: string;
  readonly password: string;
  readonly expiresAt: number;
};

export interface NativeGitRootReadIssuerClient {
  readonly endpoint: string;
  readonly hostId: string;
  readonly generationId: string;
  issueRootReadLease(projectId: string, signal: AbortSignal): Promise<NativeGitRootReadLease>;
}

export class NativeGitRootReadIssuerClientError extends Error {
  readonly name: string = "NativeGitRootReadIssuerClientError";
}

export class NativeGitRootReadIssuerRejectedError extends NativeGitRootReadIssuerClientError {
  override readonly name = "NativeGitRootReadIssuerRejectedError";

  constructor(readonly statusCode: number) {
    super(`native Git rejected the root read lease request with HTTP ${statusCode}`);
  }
}

export async function createNodeNativeGitRootReadIssuerClient(
  connectionFile: string
): Promise<NativeGitRootReadIssuerClient> {
  return createNativeGitRootReadIssuerClient(
    await loadNativeGitRootReadIssuerConnection(connectionFile),
    createNodeNativeGitAdmissionHttpClient()
  );
}

export function createNativeGitRootReadIssuerClient(
  input: NativeGitRootReadIssuerConnection,
  httpClient: NativeGitAdmissionHttpClient = createNodeNativeGitAdmissionHttpClient()
): NativeGitRootReadIssuerClient {
  const connection = parseNativeGitRootReadIssuerConnection(input);
  const authorization = `Basic ${Buffer.from(
    `${connection.credential.username}:${connection.credential.password}`,
    "utf8"
  ).toString("base64")}`;
  return {
    endpoint: connection.endpoint,
    hostId: connection.hostId,
    generationId: connection.generationId,
    async issueRootReadLease(projectId, signal) {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(projectId)) invalid();
      let response: NativeGitAdmissionHttpResponse;
      try {
        response = await httpClient.request({
          endpoint: connection.endpoint,
          method: "POST",
          path: `/v1/projects/${projectId}/root-read-leases`,
          authorization,
          body: JSON.stringify({ schemaVersion: 1, generationId: connection.generationId }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMilliseconds)])
        });
      } catch {
        throw new NativeGitRootReadIssuerClientError("native Git root read lease request failed");
      }
      const receivedAt = Date.now();
      const value = parseResponse(response);
      return parseLease(value, connection, projectId, receivedAt);
    }
  };
}

function parseResponse(response: NativeGitAdmissionHttpResponse): unknown {
  if (response.statusCode !== 201) throw new NativeGitRootReadIssuerRejectedError(response.statusCode);
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
  connection: NativeGitRootReadIssuerConnection,
  projectId: string,
  receivedAt: number
): NativeGitRootReadLease {
  const lease = exactRecord(value, leaseFields);
  if (lease.schemaVersion !== 1 || lease.serviceId !== connection.serviceId
    || lease.projectId !== projectId || lease.rootRepositoryId !== "root"
    || lease.generationId !== connection.generationId
    || typeof lease.expiresAt !== "number" || !Number.isSafeInteger(lease.expiresAt)
    || lease.expiresAt <= receivedAt
    || lease.expiresAt > receivedAt + maximumLeaseLifetimeMilliseconds) invalid();
  return {
    schemaVersion: 1,
    serviceId: "native-main",
    projectId,
    rootRepositoryId: "root",
    generationId: connection.generationId,
    username: leaseUsername(lease.username),
    password: leasePassword(lease.password),
    expiresAt: lease.expiresAt
  };
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) invalid();
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leaseUsername(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("root-read-")) invalid();
  const encoded = value.slice("root-read-".length);
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
  throw new NativeGitRootReadIssuerClientError("native Git root read lease response does not match the request");
}
