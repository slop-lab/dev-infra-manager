import type { NativeRootAdmission } from "./nativeRootAdmissionModel.js";

const maximumResponseBytes = 64 * 1024;

export function createNativeRootAdmissionResponse(input: {
  readonly serviceId: string;
  readonly generationId: string;
  readonly requestId: string;
  readonly admission: NativeRootAdmission;
}): {
  readonly schemaVersion: 1;
  readonly serviceId: string;
  readonly requestId: string;
  readonly servingGenerationId: string;
  readonly admission: NativeRootAdmission;
} {
  const response = { schemaVersion: 1, serviceId: input.serviceId, requestId: input.requestId,
    servingGenerationId: input.generationId, admission: input.admission } as const;
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > maximumResponseBytes) {
    throw new NativeRootAdmissionResponseTooLargeError();
  }
  return response;
}

export class NativeRootAdmissionResponseTooLargeError extends Error {
  readonly name = "NativeRootAdmissionResponseTooLargeError";
  constructor() { super("native root admission response exceeds the size limit"); }
}
