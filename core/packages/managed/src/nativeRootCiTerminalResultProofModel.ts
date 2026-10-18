import { createHash } from "node:crypto";
import { UserError } from "@slop-lab/dim-core";
import {
  parseNativeRootCiCurrentResultProofRequest,
  type NativeRootCiCurrentResultProofRequest
} from "./nativeRootCiResultProofModel.js";
import {
  nativeRootCiTerminalEventDigest,
  parseNativeRootCiStatusAcknowledgement,
  type NativeRootCiTerminalEvent
} from "./nativeRootCiResultProtocol.js";

const maximumResponseBytes = 64 * 1024;
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const generationPattern = /^[0-9a-f]{64}$/;
const objectPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

export type NativeRootCiCurrentTerminalProofRequest = NativeRootCiCurrentResultProofRequest;

export type NativeRootCiCurrentTerminalProof = {
  readonly schemaVersion: 1;
  readonly serviceId: string;
  readonly requestId: string;
  readonly servingGenerationId: string;
  readonly projectId: string;
  readonly repositoryId: "root";
  readonly claimId: string;
  readonly resultGenerationId: string;
  readonly serviceEpochId: string;
  readonly admissionGeneration: string;
  readonly rootSequence: number;
  readonly rootCommit: string;
  readonly rootTree: string;
  readonly cleanupResourceId: string;
  readonly cleanupComplete: true;
  readonly terminalEventDigest: string;
  readonly statusAcknowledgementJson: string;
  readonly statusAcknowledgementDigest: string;
  readonly deliveredAt: number;
};

export type NativeRootCiCurrentTerminalProofExpected = {
  readonly serviceId: string;
  readonly requestId: string;
  readonly generationId: string;
  readonly projectId: string;
  readonly reporterUsername: string;
  readonly terminalEvent: NativeRootCiTerminalEvent;
};

export const parseNativeRootCiCurrentTerminalProofRequest =
  parseNativeRootCiCurrentResultProofRequest;

export function createNativeRootCiCurrentTerminalProof(
  input: Omit<NativeRootCiCurrentTerminalProof, "schemaVersion" | "repositoryId">
): NativeRootCiCurrentTerminalProof {
  const response = { schemaVersion: 1, repositoryId: "root", ...input } as const;
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > maximumResponseBytes) {
    throw new NativeRootCiCurrentTerminalProofTooLargeError();
  }
  return response;
}

export function parseNativeRootCiCurrentTerminalProof(
  value: unknown,
  expected: NativeRootCiCurrentTerminalProofExpected
): NativeRootCiCurrentTerminalProof {
  const input = exactRecord(value, [
    "schemaVersion", "serviceId", "requestId", "servingGenerationId", "projectId", "repositoryId",
    "claimId", "resultGenerationId", "serviceEpochId", "admissionGeneration", "rootSequence", "rootCommit",
    "rootTree", "cleanupResourceId", "cleanupComplete", "terminalEventDigest",
    "statusAcknowledgementJson", "statusAcknowledgementDigest", "deliveredAt"
  ]);
  const acknowledgementJson = boundedJson(input.statusAcknowledgementJson);
  parseNativeRootCiStatusAcknowledgement(
    JSON.parse(acknowledgementJson),
    expected.terminalEvent,
    expected.reporterUsername
  );
  const claimId = text(input.claimId, uuidV4Pattern, "claim ID");
  const proof: NativeRootCiCurrentTerminalProof = {
    schemaVersion: literalOne(input.schemaVersion),
    serviceId: exactText(input.serviceId, expected.serviceId, "service ID"),
    requestId: exactText(input.requestId, expected.requestId, "request ID"),
    servingGenerationId: exactText(input.servingGenerationId, expected.generationId, "serving generation ID"),
    projectId: exactText(input.projectId, expected.projectId, "Project ID"),
    repositoryId: root(input.repositoryId),
    claimId,
    resultGenerationId: text(input.resultGenerationId, generationPattern, "result generation ID"),
    serviceEpochId: text(input.serviceEpochId, uuidV4Pattern, "service epoch ID"),
    admissionGeneration: text(input.admissionGeneration, uuidV4Pattern, "admission generation"),
    rootSequence: nonnegativeInteger(input.rootSequence, "root sequence"),
    rootCommit: text(input.rootCommit, objectPattern, "root commit"),
    rootTree: text(input.rootTree, objectPattern, "root tree"),
    cleanupResourceId: exactText(input.cleanupResourceId, claimId, "cleanup resource ID"),
    cleanupComplete: completed(input.cleanupComplete),
    terminalEventDigest: text(input.terminalEventDigest, digestPattern, "terminal event digest"),
    statusAcknowledgementJson: acknowledgementJson,
    statusAcknowledgementDigest: text(input.statusAcknowledgementDigest, digestPattern,
      "status acknowledgement digest"),
    deliveredAt: nonnegativeInteger(input.deliveredAt, "delivery time")
  };
  const acknowledgementDigest = `sha256:${createHash("sha256").update(acknowledgementJson, "utf8").digest("hex")}`;
  if (proof.terminalEventDigest !== nativeRootCiTerminalEventDigest(expected.terminalEvent)
    || proof.statusAcknowledgementDigest !== acknowledgementDigest
    || proof.resultGenerationId !== proof.servingGenerationId
    || proof.projectId !== expected.terminalEvent.payload.descriptor.projectId
    || expected.terminalEvent.payload.descriptor.repositoryId !== "root"
    || proof.admissionGeneration !== expected.terminalEvent.payload.descriptor.admissionGeneration
    || proof.rootCommit.length !== proof.rootTree.length) {
    invalid("native root CI current-terminal proof is inconsistent");
  }
  return proof;
}

export class NativeRootCiCurrentTerminalProofTooLargeError extends Error {
  readonly name = "NativeRootCiCurrentTerminalProofTooLargeError";
  constructor() { super("native root CI current-terminal proof exceeds the size limit"); }
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    invalid("response body has invalid fields");
  }
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)]));
}
function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}
function exactText(value: unknown, expected: string, label: string): string {
  if (value !== expected) invalid(`${label} is inconsistent`);
  return expected;
}
function literalOne(value: unknown): 1 {
  if (value !== 1) invalid("native root CI current-terminal proof schemaVersion must be 1");
  return 1;
}
function root(value: unknown): "root" {
  if (value !== "root") invalid("native root CI current-terminal proof repository is invalid");
  return "root";
}
function completed(value: unknown): true {
  if (value !== true) invalid("native root CI current-terminal proof cleanup is incomplete");
  return true;
}
function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(`${label} is invalid`);
  return value;
}
function boundedJson(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumResponseBytes) {
    invalid("status acknowledgement JSON is invalid");
  }
  try { JSON.parse(value); }
  catch (error) {
    if (error instanceof SyntaxError) invalid("status acknowledgement JSON is invalid");
    throw error;
  }
  return value;
}
function invalid(message: string): never { throw new UserError(message); }
