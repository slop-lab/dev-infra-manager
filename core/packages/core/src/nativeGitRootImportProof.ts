import type { NativeGitRootImportResult } from "./nativeGitRootImporterClient.js";
import type { NativeGitRootImporterConnection } from "./nativeGitRootImporterConnection.js";

const proofFields = ["schemaVersion", "servingGenerationId", "ownerHostId", "importReceipt",
  "currentHead"] as const;
const receiptFields = ["schemaVersion", "serviceId", "projectId", "rootRepositoryId", "generationId",
  "importNonce", "protectedRef", "expectedCommit", "resolvedTree", "policyDigest", "bundleDigest",
  "bundleSize", "phase"] as const;
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const digestPattern = /^[0-9a-f]{64}$/;
const currentHeadFields = ["projectId", "sequence", "protectedRef", "commit", "tree", "policyDigest"] as const;

export type NativeGitCurrentRootHead = {
  readonly projectId: string;
  readonly sequence: number;
  readonly protectedRef: string;
  readonly commit: string;
  readonly tree: string;
  readonly policyDigest: string;
};

export type NativeGitImportedRootProof = {
  readonly schemaVersion: 3;
  readonly servingGenerationId: string;
  readonly ownerHostId: string;
  readonly importReceipt: NativeGitRootImportResult;
  readonly currentHead: NativeGitCurrentRootHead;
};

export class NativeGitRootImportProofError extends Error {
  readonly name = "NativeGitRootImportProofError";
}

export function parseNativeGitImportedRootProof(
  input: unknown,
  connection: NativeGitRootImporterConnection,
  projectId: string
): NativeGitImportedRootProof {
  const proof = exactRecord(input, proofFields);
  if (proof.schemaVersion !== 3 || proof.servingGenerationId !== connection.generationId
    || proof.ownerHostId !== connection.hostId) invalid();
  const receipt = exactRecord(proof.importReceipt, receiptFields);
  if (receipt.schemaVersion !== 1 || receipt.serviceId !== connection.serviceId
    || receipt.projectId !== projectId || receipt.rootRepositoryId !== "root"
    || receipt.phase !== "root-imported") invalid();
  const protectedRef = field(receipt.protectedRef, /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/);
  if (protectedRef.startsWith("refs/heads/proposals/") || protectedRef.includes("..")
    || protectedRef.endsWith("/") || protectedRef.endsWith(".") || protectedRef.endsWith(".lock")
    || protectedRef.slice("refs/heads/".length).split("/").some((part) => part.startsWith("."))) invalid();
  const expectedCommit = field(receipt.expectedCommit, objectIdPattern);
  const resolvedTree = field(receipt.resolvedTree, objectIdPattern);
  if (expectedCommit.length !== resolvedTree.length) invalid();
  if (typeof receipt.bundleSize !== "number" || !Number.isSafeInteger(receipt.bundleSize)
    || receipt.bundleSize < 1 || receipt.bundleSize > 256 * 1024 * 1024) invalid();
  const current = exactRecord(proof.currentHead, currentHeadFields);
  const sequence = current.sequence;
  const currentCommit = field(current.commit, objectIdPattern);
  const currentTree = field(current.tree, objectIdPattern);
  if (current.projectId !== projectId || current.protectedRef !== protectedRef
    || current.policyDigest !== receipt.policyDigest || typeof sequence !== "number"
    || !Number.isSafeInteger(sequence) || sequence < 0
    || currentCommit.length !== expectedCommit.length || currentTree.length !== expectedCommit.length
    || (sequence === 0 && (currentCommit !== expectedCommit || currentTree !== resolvedTree))) invalid();
  return {
    schemaVersion: 3,
    servingGenerationId: connection.generationId,
    ownerHostId: connection.hostId,
    importReceipt: {
      schemaVersion: 1,
      serviceId: "native-main",
      projectId,
      rootRepositoryId: "root",
      generationId: field(receipt.generationId, digestPattern),
      importNonce: field(receipt.importNonce,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      protectedRef,
      expectedCommit,
      resolvedTree,
      policyDigest: field(receipt.policyDigest, digestPattern),
      bundleDigest: field(receipt.bundleDigest, digestPattern),
      bundleSize: receipt.bundleSize,
      phase: "root-imported"
    },
    currentHead: { projectId, sequence, protectedRef, commit: currentCommit, tree: currentTree,
      policyDigest: field(current.policyDigest, digestPattern) }
  };
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length
    || fields.some((fieldName) => !Object.hasOwn(value, fieldName))) invalid();
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}

function invalid(): never {
  throw new NativeGitRootImportProofError("native Git imported root proof is invalid");
}
