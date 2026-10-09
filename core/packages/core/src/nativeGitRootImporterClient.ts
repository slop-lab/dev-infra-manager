import { createHash } from "node:crypto";
import { createNodeNativeGitAdmissionHttpClient } from "./nativeGitAdmissionHttpClient.js";
import type { NativeGitAdmissionHttpClient, NativeGitAdmissionHttpResponse } from "./nativeGitAdmissionSource.js";
import {
  loadNativeGitRootImporterConnection,
  parseNativeGitRootImporterConnection,
  type NativeGitRootImporterConnection
} from "./nativeGitRootImporterConnection.js";
import { NativeGitRootImportProofError, parseNativeGitImportedRootProof,
  type NativeGitImportedRootProof } from "./nativeGitRootImportProof.js";
import { uploadNativeGitRootBundle } from "./nativeGitRootImporterTransport.js";

export type { NativeGitImportedRootProof } from "./nativeGitRootImportProof.js";

const requestTimeoutMilliseconds = 5_000;
const maximumResponseBytes = 64 * 1024;
const receiptFields = ["schemaVersion", "serviceId", "projectId", "rootRepositoryId", "generationId",
  "importNonce", "protectedRef", "expectedCommit", "policyDigest", "bundleDigest", "bundleSize", "phase"] as const;

export type NativeGitRootImportRequest = {
  readonly serviceId: "native-main";
  readonly projectId: string;
  readonly rootRepositoryId: "root";
  readonly protectedRef: string;
  readonly expectedCommit: string;
  readonly policy: unknown;
  readonly bundlePath: string;
};

export type NativeGitRootImportResult = {
  readonly schemaVersion: 1;
  readonly serviceId: "native-main";
  readonly projectId: string;
  readonly rootRepositoryId: "root";
  readonly generationId: string;
  readonly importNonce: string;
  readonly protectedRef: string;
  readonly expectedCommit: string;
  readonly policyDigest: string;
  readonly bundleDigest: string;
  readonly bundleSize: number;
  readonly resolvedTree: string;
  readonly phase: "root-imported";
};

export interface NativeGitRootImporterClient {
  readonly hostId: string;
  readonly generationId: string;
  attest(signal: AbortSignal): Promise<void>;
  proveRoot(projectId: string, signal: AbortSignal): Promise<NativeGitImportedRootProof>;
  importRoot(input: NativeGitRootImportRequest, signal: AbortSignal): Promise<NativeGitRootImportResult>;
}

export class NativeGitRootImporterClientError extends Error {
  readonly name = "NativeGitRootImporterClientError";
}

type ImportHttp = {
  readonly client: NativeGitAdmissionHttpClient;
  readonly connection: NativeGitRootImporterConnection;
  readonly authorization: string;
};

type ImportHttpRequest = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: string;
  readonly signal: AbortSignal;
};

type ReceiptExpectation = {
  readonly input: NativeGitRootImportRequest;
  readonly connection: NativeGitRootImporterConnection;
  readonly policyDigest: string;
  readonly bundleDigest: string;
  readonly bundleSize: number;
};

export async function createNodeNativeGitRootImporterClient(
  path: string
): Promise<NativeGitRootImporterClient> {
  return createNativeGitRootImporterClient(await loadNativeGitRootImporterConnection(path));
}

export function createNativeGitRootImporterClient(
  input: NativeGitRootImporterConnection,
  httpClient: NativeGitAdmissionHttpClient = createNodeNativeGitAdmissionHttpClient()
): NativeGitRootImporterClient {
  const connection = parseNativeGitRootImporterConnection(input);
  const authorization = `Basic ${Buffer.from(
    `${connection.credential.username}:${connection.credential.password}`, "utf8"
  ).toString("base64")}`;
  const http = { client: httpClient, connection, authorization };
  async function attest(signal: AbortSignal): Promise<void> {
    const identity = exactRecord(await jsonRequest(http, {
      method: "GET", path: "/v1/operator-root-importer-identity", signal
    }),
    ["schemaVersion", "serviceId", "role", "hostId", "generationId"]);
    if (identity.schemaVersion !== 1 || identity.serviceId !== connection.serviceId
      || identity.role !== connection.role || identity.hostId !== connection.hostId
      || identity.generationId !== connection.generationId) invalid();
  }
  return {
    hostId: connection.hostId,
    generationId: connection.generationId,
    attest,
    async proveRoot(projectId, signal) {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(projectId)) invalid();
      await attest(signal);
      const response = await jsonRequest(http, {
        method: "GET", path: `/v1/projects/${projectId}/root-import/proof`, signal
      });
      try {
        return parseNativeGitImportedRootProof(response, connection, projectId);
      } catch (error) {
        if (error instanceof NativeGitRootImportProofError) invalid();
        throw error;
      }
    },
    async importRoot(input, signal) {
      if (input.serviceId !== "native-main" || input.rootRepositoryId !== "root"
        || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(input.projectId)
        || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.expectedCommit)) invalid();
      const policyJson = JSON.stringify(input.policy);
      if (typeof policyJson !== "string") invalid();
      const policyDigest = createHash("sha256").update(policyJson, "utf8").digest("hex");
      await attest(signal);
      let upload;
      try {
        upload = await uploadNativeGitRootBundle({
          connection, authorization, projectId: input.projectId, bundlePath: input.bundlePath,
          prelude: { schemaVersion: 1, generationId: connection.generationId, serviceId: input.serviceId,
            projectId: input.projectId, rootRepositoryId: input.rootRepositoryId,
            protectedRef: input.protectedRef, expectedCommit: input.expectedCommit, policy: input.policy },
          signal
        });
      } catch {
        throw new NativeGitRootImporterClientError("native Git root import bundle upload failed");
      }
      const uploaded = exactRecord(parseJsonResponse(upload.response), receiptFields);
      const expectation = { input, connection, policyDigest,
        bundleDigest: upload.bundleDigest, bundleSize: upload.bundleSize };
      if (uploaded.phase !== "bundle-durable" && uploaded.phase !== "root-imported") invalid();
      assertReceipt(uploaded, expectation, uploaded.phase);
      const nonce = requiredString(uploaded.importNonce, /^[0-9a-f-]{36}$/);
      await attest(signal);
      const finalized = exactRecord(await jsonRequest(http, {
        method: "POST", path: `/v1/projects/${input.projectId}/root-import/finalize`, body: JSON.stringify({
          schemaVersion: 1, generationId: connection.generationId,
          importNonce: nonce, bundleDigest: upload.bundleDigest
        }), signal
      }), [...receiptFields, "resolvedTree"]);
      assertReceipt(finalized, expectation, "root-imported");
      for (const field of receiptFields) if (finalized[field] !== uploaded[field] && field !== "phase") invalid();
      return {
        schemaVersion: 1, serviceId: "native-main", projectId: input.projectId,
        rootRepositoryId: "root", generationId: connection.generationId, importNonce: nonce,
        protectedRef: input.protectedRef, expectedCommit: input.expectedCommit,
        policyDigest: requiredString(finalized.policyDigest, /^[0-9a-f]{64}$/),
        bundleDigest: upload.bundleDigest, bundleSize: upload.bundleSize,
        resolvedTree: requiredString(finalized.resolvedTree, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        phase: "root-imported"
      };
    }
  };
}

async function jsonRequest(http: ImportHttp, input: ImportHttpRequest): Promise<unknown> {
  let response: NativeGitAdmissionHttpResponse;
  try {
    response = await http.client.request({ endpoint: http.connection.endpoint,
      authorization: http.authorization, method: input.method, path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(requestTimeoutMilliseconds)]) });
  } catch {
    throw new NativeGitRootImporterClientError("native Git root importer request failed");
  }
  return parseJsonResponse(response);
}

function parseJsonResponse(response: NativeGitAdmissionHttpResponse): unknown {
  if (response.statusCode !== 200) {
    throw new NativeGitRootImporterClientError(`native Git root importer rejected request with HTTP ${response.statusCode}`);
  }
  if (response.contentType !== "application/json" || response.cacheControl !== "no-store"
    || response.body.length > maximumResponseBytes) invalid();
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) invalid();
    throw error;
  }
}

function assertReceipt(value: Readonly<Record<string, unknown>>,
  expectation: ReceiptExpectation, phase: "bundle-durable" | "root-imported"): void {
  const { input, connection, policyDigest, bundleDigest, bundleSize } = expectation;
  if (value.schemaVersion !== 1 || value.serviceId !== input.serviceId || value.projectId !== input.projectId
    || value.rootRepositoryId !== input.rootRepositoryId || value.generationId !== connection.generationId
    || value.protectedRef !== input.protectedRef || value.expectedCommit !== input.expectedCommit
    || value.policyDigest !== policyDigest || value.bundleDigest !== bundleDigest
    || value.bundleSize !== bundleSize || value.phase !== phase) invalid();
  requiredString(value.importNonce, /^[0-9a-f-]{36}$/);
  requiredString(value.policyDigest, /^[0-9a-f]{64}$/);
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))) invalid();
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}

function invalid(): never {
  throw new NativeGitRootImporterClientError("native Git root importer response does not match the request");
}
