import { isDeepStrictEqual } from "node:util";
import { UserError } from "./errors.js";
import {
  nativeRootCiTerminalEventDigest,
  parseNativeRootCiTerminalEvent,
  type NativeRootCiTerminalEvent
} from "./nativeRootCiResultProtocol.js";

const maximumResponseBytes = 64 * 1024;
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const generationPattern = /^[0-9a-f]{64}$/;
const objectPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

export type NativeRootCiCurrentResultProofRequest = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly generationId: string;
  readonly terminalEvent: NativeRootCiTerminalEvent;
};

export type NativeRootCiCurrentResultProof = {
  readonly schemaVersion: 1;
  readonly serviceId: string;
  readonly requestId: string;
  readonly servingGenerationId: string;
  readonly projectId: string;
  readonly repositoryId: "root";
  readonly claimId: string;
  readonly serviceEpochId: string;
  readonly admissionGeneration: string;
  readonly rootSequence: number;
  readonly rootCommit: string;
  readonly rootTree: string;
  readonly cleanupComplete: true;
  readonly terminalEvent: NativeRootCiTerminalEvent;
  readonly terminalEventDigest: string;
};

export type NativeRootCiCurrentResultProofExpected = {
  readonly serviceId: string;
  readonly requestId: string;
  readonly generationId: string;
  readonly projectId: string;
  readonly terminalEvent: NativeRootCiTerminalEvent;
};

export function parseNativeRootCiCurrentResultProofRequest(
  value: unknown
): NativeRootCiCurrentResultProofRequest {
  const input = exactRecord(value, ["schemaVersion", "requestId", "generationId", "terminalEvent"]);
  if (input.schemaVersion !== 1) invalid("native root CI current-result proof schemaVersion must be 1");
  return {
    schemaVersion: 1,
    requestId: text(input.requestId, uuidV4Pattern, "request ID"),
    generationId: text(input.generationId, generationPattern, "generation ID"),
    terminalEvent: parseNativeRootCiTerminalEvent(input.terminalEvent)
  };
}

export function createNativeRootCiCurrentResultProof(
  input: Omit<NativeRootCiCurrentResultProof, "schemaVersion" | "repositoryId">
): NativeRootCiCurrentResultProof {
  const response = { schemaVersion: 1, repositoryId: "root", ...input } as const;
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > maximumResponseBytes) {
    throw new NativeRootCiCurrentResultProofTooLargeError();
  }
  return response;
}

export function parseNativeRootCiCurrentResultProof(
  value: unknown,
  expected: NativeRootCiCurrentResultProofExpected
): NativeRootCiCurrentResultProof {
  const input = exactRecord(value, [
    "schemaVersion", "serviceId", "requestId", "servingGenerationId", "projectId", "repositoryId",
    "claimId", "serviceEpochId", "admissionGeneration", "rootSequence", "rootCommit", "rootTree",
    "cleanupComplete", "terminalEvent", "terminalEventDigest"
  ]);
  const terminalEvent = parseNativeRootCiTerminalEvent(input.terminalEvent);
  const proof: NativeRootCiCurrentResultProof = {
    schemaVersion: literalOne(input.schemaVersion),
    serviceId: exactText(input.serviceId, expected.serviceId, "service ID"),
    requestId: exactText(input.requestId, expected.requestId, "request ID"),
    servingGenerationId: exactText(input.servingGenerationId, expected.generationId, "serving generation ID"),
    projectId: exactText(input.projectId, expected.projectId, "Project ID"),
    repositoryId: root(input.repositoryId),
    claimId: text(input.claimId, uuidV4Pattern, "claim ID"),
    serviceEpochId: text(input.serviceEpochId, uuidV4Pattern, "service epoch ID"),
    admissionGeneration: text(input.admissionGeneration, uuidV4Pattern, "admission generation"),
    rootSequence: nonnegativeInteger(input.rootSequence),
    rootCommit: text(input.rootCommit, objectPattern, "root commit"),
    rootTree: text(input.rootTree, objectPattern, "root tree"),
    cleanupComplete: completed(input.cleanupComplete),
    terminalEvent,
    terminalEventDigest: text(input.terminalEventDigest, digestPattern, "terminal event digest")
  };
  if (!isDeepStrictEqual(proof.terminalEvent, expected.terminalEvent)
    || proof.terminalEventDigest !== nativeRootCiTerminalEventDigest(terminalEvent)
    || proof.projectId !== proof.terminalEvent.payload.descriptor.projectId
    || proof.terminalEvent.payload.descriptor.repositoryId !== "root"
    || proof.admissionGeneration !== proof.terminalEvent.payload.descriptor.admissionGeneration
    || proof.rootCommit.length !== proof.rootTree.length) {
    invalid("native root CI current-result proof event is inconsistent");
  }
  return proof;
}

export class NativeRootCiCurrentResultProofTooLargeError extends Error {
  readonly name = "NativeRootCiCurrentResultProofTooLargeError";
  constructor() { super("native root CI current-result proof exceeds the size limit"); }
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    invalid("request body has invalid fields");
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
  if (value !== 1) invalid("native root CI current-result proof schemaVersion must be 1");
  return 1;
}
function root(value: unknown): "root" {
  if (value !== "root") invalid("native root CI current-result proof repository is invalid");
  return "root";
}
function completed(value: unknown): true {
  if (value !== true) invalid("native root CI current-result proof cleanup is incomplete");
  return true;
}
function nonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid("root sequence is invalid");
  return value;
}
function invalid(message: string): never { throw new UserError(message); }
