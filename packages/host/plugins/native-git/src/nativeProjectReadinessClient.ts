import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import type { NativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import type { NativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import type { NativeProjectRecord } from "./nativeProjectPendingCodec.js";

const responseFields = ["schemaVersion", "serviceId", "ownerHostId", "projectId", "repositoryId",
  "generationId", "protectedRef", "commit", "tree", "policyRevision"] as const;
const issuerIdentityFields = ["schemaVersion", "serviceId", "role", "hostId", "generationId"] as const;

export type NativeProjectReadinessProof = {
  readonly schemaVersion: 1;
  readonly serviceId: "native-main";
  readonly ownerHostId: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly generationId: string;
  readonly protectedRef: string;
  readonly commit: string;
  readonly tree: string;
  readonly policyRevision: string;
};

export class NativeProjectReadinessClientError extends Error {
  readonly name = "NativeProjectReadinessClientError";
}

export type NativeWorkspaceWriteIssuerIdentity = {
  readonly schemaVersion: 1;
  readonly serviceId: "native-main";
  readonly role: "operator-workspace-write-issuer";
  readonly hostId: string;
  readonly generationId: string;
};

export async function attestNativeWorkspaceWriteIssuer(
  connection: NativeControlPlaneConnection,
  signal: AbortSignal,
  httpClient: NativeGitAdmissionHttpClient = createNodeNativeGitAdmissionHttpClient()
): Promise<NativeWorkspaceWriteIssuerIdentity> {
  const response = await httpClient.request({
    endpoint: connection.nativeGit.endpoint,
    method: "GET",
    path: "/v1/operator-workspace-write-issuer-identity",
    authorization: issuerAuthorization(connection),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)])
  });
  const identity = exactRecord(parseResponse(response), issuerIdentityFields);
  if (identity.schemaVersion !== 1 || identity.serviceId !== connection.nativeGit.serviceId
    || identity.role !== "operator-workspace-write-issuer" || identity.hostId !== connection.hostId
    || identity.generationId !== connection.nativeGit.generationId) invalid();
  return { schemaVersion: 1, serviceId: "native-main", role: "operator-workspace-write-issuer",
    hostId: connection.hostId, generationId: identity.generationId };
}

export async function proveNativeProjectReadiness(
  connection: NativeControlPlaneConnection,
  record: NativeProjectRecord,
  repositoryId: string,
  signal: AbortSignal,
  selectedRoot?: { readonly commit: string; readonly tree: string; readonly allowFastForward?: true },
  httpClient: NativeGitAdmissionHttpClient = createNodeNativeGitAdmissionHttpClient()
): Promise<NativeProjectReadinessProof> {
  const repository = record.repositories[repositoryId];
  if (!repository) invalid();
  const selected = selectedRoot ?? { commit: repository.commit, tree: repository.tree };
  const generationId = (await attestNativeWorkspaceWriteIssuer(connection, signal, httpClient)).generationId;
  const response = await httpClient.request({
    endpoint: connection.nativeGit.endpoint,
    method: "POST",
    path: `/v1/projects/${record.projectId}/repositories/${repositoryId}/workspace-readiness`,
    authorization: issuerAuthorization(connection),
    body: JSON.stringify({
      schemaVersion: 1,
      generationId,
      repositoryId,
      protectedRef: repository.protectedRef,
      commit: selected.commit,
      tree: selected.tree,
      policyRevision: repository.repositoryPolicy.policyRevision
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)])
  });
  const proof = exactRecord(parseResponse(response), responseFields);
  if (proof.schemaVersion !== 1 || proof.serviceId !== connection.nativeGit.serviceId
    || proof.ownerHostId !== connection.hostId || proof.projectId !== record.projectId
    || proof.repositoryId !== repositoryId || proof.generationId !== generationId
    || proof.protectedRef !== repository.protectedRef || !objectId(proof.commit)
    || !objectId(proof.tree) || proof.policyRevision !== repository.repositoryPolicy.policyRevision
    || (selected.allowFastForward !== true
      && (proof.commit !== selected.commit || proof.tree !== selected.tree))) invalid();
  return {
    schemaVersion: 1, serviceId: "native-main", ownerHostId: connection.hostId,
    projectId: record.projectId, repositoryId, generationId,
    protectedRef: repository.protectedRef, commit: proof.commit, tree: proof.tree,
    policyRevision: repository.repositoryPolicy.policyRevision
  };
}

function issuerAuthorization(connection: NativeControlPlaneConnection): string {
  return `Basic ${Buffer.from(
    `${connection.nativeGit.workspaceWriteIssuer.username}:${connection.nativeGit.workspaceWriteIssuer.password}`,
    "utf8"
  ).toString("base64")}`;
}

function parseResponse(response: Awaited<ReturnType<NativeGitAdmissionHttpClient["request"]>>): unknown {
  if (response.statusCode !== 200 || response.contentType !== "application/json"
    || response.cacheControl !== "no-store" || response.body.length > 64 * 1024) invalid();
  let value: unknown;
  try {
    value = JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) invalid();
    throw error;
  }
  return value;
}

function objectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))) invalid();
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new NativeProjectReadinessClientError("native Project workspace readiness proof is invalid");
}
