import { createHash } from "node:crypto";
import type { NativeRootCiPolicyProof } from "./nativeRootCiProofModel.js";

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

export class NativeRootAdmissionRequestError extends Error {
  readonly name = "NativeRootAdmissionRequestError";
}
