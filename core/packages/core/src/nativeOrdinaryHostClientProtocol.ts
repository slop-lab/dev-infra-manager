import { UserError } from "./errors.js";
import { nativeDescriptorDigest, parseNativeDescriptor } from "./nativeOrdinaryAuthorityModel.js";
import type {
  NativeHostClaim,
  NativeHostClaimRenewal,
  NativeHostClaimRenewalRequest,
  NativeHostRecoveryRequest
} from "./nativeOrdinaryClaimProtocol.js";

export function parseNativeHostClaimResponse(value: unknown): NativeHostClaim {
  const input = exactRecord(value, [
    "schemaVersion", "serviceId", "requestId", "claimId", "eventId", "reviewId", "attemptId", "attempt",
    "admissionGeneration", "hostId", "capacity", "leaseExpiresAt", "descriptor", "descriptorDigest"
  ]);
  const descriptor = parseBoundary(() => parseNativeDescriptor(input.descriptor));
  const descriptorDigest = digest(input.descriptorDigest);
  if (nativeDescriptorDigest(descriptor) !== descriptorDigest
    || descriptor.admissionGeneration !== input.admissionGeneration) {
    throw new NativeOrdinaryHostClientError("native ordinary claim descriptor binding is invalid");
  }
  return {
    schemaVersion: literalOne(input.schemaVersion),
    serviceId: identifier(input.serviceId, "service ID"),
    requestId: uuid(input.requestId, "request ID"),
    claimId: uuid(input.claimId, "claim ID"),
    eventId: uuid(input.eventId, "event ID"),
    reviewId: hex(input.reviewId, 64, "review ID"),
    attemptId: uuid(input.attemptId, "attempt ID"),
    attempt: positiveInteger(input.attempt, "attempt"),
    admissionGeneration: identifier(input.admissionGeneration, "admission generation"),
    hostId: identifier(input.hostId, "host ID"),
    capacity: identifier(input.capacity, "capacity"),
    leaseExpiresAt: positiveInteger(input.leaseExpiresAt, "lease expiry"),
    descriptor,
    descriptorDigest
  };
}

export function parseNativeHostRenewalRequest(
  input: NativeHostClaimRenewalRequest,
  hostId: string,
  capacity: string
): NativeHostClaimRenewalRequest {
  if (input.schemaVersion !== 1 || input.hostId !== hostId || input.capacity !== capacity) {
    throw new NativeOrdinaryHostClientError("native ordinary renewal is outside configured capacity");
  }
  return {
    schemaVersion: 1,
    requestId: uuid(input.requestId, "request ID"),
    hostId,
    capacity,
    claimId: uuid(input.claimId, "claim ID"),
    attemptId: uuid(input.attemptId, "attempt ID"),
    descriptorDigest: digest(input.descriptorDigest)
  };
}

export function parseNativeHostRecoveryRequest(
  input: NativeHostRecoveryRequest,
  hostId: string,
  capacity: string
): NativeHostRecoveryRequest {
  const renewal = parseNativeHostRenewalRequest(input, hostId, capacity);
  if (input.cleanupComplete !== true || input.resourceId !== input.claimId) {
    throw new NativeOrdinaryHostClientError("native ordinary recovery requires exact completed cleanup");
  }
  return { ...renewal, resourceId: uuid(input.resourceId, "resource ID"), cleanupComplete: true };
}

export function parseNativeHostRenewalResponse(value: unknown): NativeHostClaimRenewal {
  const input = exactRecord(value, [
    "schemaVersion", "serviceId", "requestId", "claimId", "leaseExpiresAt", "leaseDurationMilliseconds"
  ]);
  return {
    schemaVersion: literalOne(input.schemaVersion),
    serviceId: identifier(input.serviceId, "service ID"),
    requestId: uuid(input.requestId, "request ID"),
    claimId: uuid(input.claimId, "claim ID"),
    leaseExpiresAt: positiveInteger(input.leaseExpiresAt, "lease expiry"),
    leaseDurationMilliseconds: positiveInteger(input.leaseDurationMilliseconds, "lease duration")
  };
}

export function exactNativeHostResponse(
  value: unknown,
  keys: readonly string[]
): Readonly<Record<string, unknown>> {
  return exactRecord(value, keys);
}

export function nativeHostIdentifier(value: unknown, label: string): string {
  return identifier(value, label);
}

export function nativeHostUuid(value: unknown, label: string): string {
  return uuid(value, label);
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => Reflect.get(value, key) === undefined)) {
    throw new NativeOrdinaryHostClientError("native ordinary host response fields are invalid");
  }
  return Object.fromEntries(keys.map((key) => [key, Reflect.get(value, key)]));
}

function parseBoundary<T>(parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    if (error instanceof UserError) throw new NativeOrdinaryHostClientError("native ordinary host response value is invalid", { cause: error });
    throw error;
  }
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new NativeOrdinaryHostClientError(`${label} is invalid`);
  return value;
}

const identifier = (value: unknown, label: string) => text(value, /^[a-z0-9][a-z0-9._-]{0,127}$/, label);
const uuid = (value: unknown, label: string) => text(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, label);
const digest = (value: unknown) => text(value, /^sha256:[0-9a-f]{64}$/, "descriptor digest");
const hex = (value: unknown, length: number, label: string) => text(value, new RegExp(`^[0-9a-f]{${length}}$`), label);

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new NativeOrdinaryHostClientError(`${label} is invalid`);
  return value;
}

function literalOne(value: unknown): 1 {
  if (value !== 1) throw new NativeOrdinaryHostClientError("schemaVersion must be 1");
  return 1;
}

export class NativeOrdinaryHostClientError extends Error {
  readonly name: string = "NativeOrdinaryHostClientError";
}
