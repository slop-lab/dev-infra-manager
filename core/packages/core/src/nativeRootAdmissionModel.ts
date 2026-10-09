import { createHash } from "node:crypto";
import type { NativeRootCiPolicyProof } from "./nativeRootCiProofModel.js";

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const generationPattern = /^[0-9a-f]{64}$/;

export type NativeRootAdmissionOperation = "register" | "current" | "revoke";
export type NativeRootAdmissionRequest = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly generationId: string;
  readonly admissionGeneration?: string;
};
export type NativeRootAdmission = {
  readonly schemaVersion: 1;
  readonly admissionGeneration: string;
  readonly capacityConfigDigest: string;
  readonly expiresAt: number;
  readonly importedRoot: {
    readonly serviceId: "native-main";
    readonly servingGenerationId: string;
    readonly projectId: string;
    readonly repositoryId: "root";
    readonly currentRoot: NativeRootCiPolicyProof["currentRoot"];
    readonly policy: NativeRootCiPolicyProof["policy"];
  };
};

export function parseNativeRootAdmissionRequest(
  value: unknown,
  operation: NativeRootAdmissionOperation
): NativeRootAdmissionRequest {
  const fields = operation === "register"
    ? ["schemaVersion", "requestId", "generationId"]
    : ["schemaVersion", "requestId", "generationId", "admissionGeneration"];
  const input = exactRecord(value, fields);
  const admissionGeneration = input.admissionGeneration;
  if (input.schemaVersion !== 1 || typeof input.requestId !== "string" || !uuidV4Pattern.test(input.requestId)
    || typeof input.generationId !== "string" || !generationPattern.test(input.generationId)
    || operation !== "register"
      && (typeof admissionGeneration !== "string" || !uuidV4Pattern.test(admissionGeneration))) invalid();
  return operation === "register"
    ? { schemaVersion: 1, requestId: input.requestId, generationId: input.generationId }
    : { schemaVersion: 1, requestId: input.requestId, generationId: input.generationId,
      admissionGeneration: String(admissionGeneration) };
}

export function nativeRootAdmissionTupleDigest(
  operation: NativeRootAdmissionOperation,
  projectId: string,
  request: NativeRootAdmissionRequest
): string {
  return createHash("sha256").update("dim-native-root-admission-request-v1\0")
    .update(JSON.stringify({ operation, projectId, ...request })).digest("hex");
}

export function nativeRootAdmissionBindingDigest(input: {
  readonly ordinaryServiceId: string;
  readonly controlPlaneGenerationId: string;
  readonly nativeServiceId: string;
  readonly projectId: string;
  readonly importNonce: string;
  readonly protectedRef: string;
  readonly policyDigest: string;
  readonly policy: NativeRootCiPolicyProof["policy"];
  readonly capacityConfigDigest: string;
}): string {
  return createHash("sha256").update("dim-native-root-admission-binding-v1\0")
    .update(JSON.stringify({ ordinaryServiceId: input.ordinaryServiceId,
      controlPlaneGenerationId: input.controlPlaneGenerationId, nativeServiceId: input.nativeServiceId,
      projectId: input.projectId, repositoryId: "root", importNonce: input.importNonce,
      protectedRef: input.protectedRef, policyDigest: input.policyDigest, policy: input.policy,
      capacityConfigDigest: input.capacityConfigDigest })).digest("hex");
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) invalid();
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)]));
}

function invalid(): never {
  throw new NativeRootAdmissionRequestError("native root admission request is invalid");
}

export class NativeRootAdmissionRequestError extends Error {
  readonly name = "NativeRootAdmissionRequestError";
}
