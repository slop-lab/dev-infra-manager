import { UserError } from "./errors.js";
import { parseNativeJobAttemptIssuance, type NativeJobAttemptIssuance } from "./nativeGitAttemptIssuerModel.js";
import { parseNativeAdmissionPolicy, parseNativeDescriptor, record } from "./nativeOrdinaryAuthorityModel.js";
import type { NativeAdmissionPolicy, NativeOrdinaryDescriptor } from "./nativeOrdinaryAuthorityProtocol.js";
import { parseNativeReviewJobEvent, type NativeReviewJobEvent } from "./nativeOrdinaryEvent.js";

export type NativeHostClaimRequest = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly hostId: string;
  readonly capacity: string;
};

export type NativeHostClaim = {
  readonly schemaVersion: 1;
  readonly serviceId: string;
  readonly requestId: string;
  readonly claimId: string;
  readonly eventId: string;
  readonly reviewId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly admissionGeneration: string;
  readonly hostId: string;
  readonly capacity: string;
  readonly leaseExpiresAt: number;
  readonly descriptor: NativeOrdinaryDescriptor;
  readonly descriptorDigest: string;
};

export type NativeHostClaimRenewalRequest = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly hostId: string;
  readonly capacity: string;
  readonly claimId: string;
  readonly attemptId: string;
  readonly descriptorDigest: string;
};

export type NativeHostClaimRenewal = {
  readonly schemaVersion: 1;
  readonly serviceId: string;
  readonly requestId: string;
  readonly claimId: string;
  readonly leaseExpiresAt: number;
  readonly leaseDurationMilliseconds: number;
};

export type NativeHostRecoveryRequest = NativeHostClaimRenewalRequest & {
  readonly resourceId: string;
  readonly cleanupComplete: true;
};

export function parseNativeHostClaimRequest(value: unknown): NativeHostClaimRequest {
  const input = exactRecord(value, ["schemaVersion", "requestId", "hostId", "capacity"]);
  if (input.schemaVersion !== 1) throw new UserError("native host claim schemaVersion must be 1");
  return {
    schemaVersion: 1,
    requestId: uuid(input.requestId, "request ID"),
    hostId: identifier(input.hostId, "host ID"),
    capacity: identifier(input.capacity, "capacity")
  };
}

export function parseNativeHostClaimRenewalRequest(value: unknown): NativeHostClaimRenewalRequest {
  const input = exactRecord(value, [
    "schemaVersion", "requestId", "hostId", "capacity", "claimId", "attemptId", "descriptorDigest"
  ]);
  if (input.schemaVersion !== 1) throw new UserError("native host claim renewal schemaVersion must be 1");
  return parseClaimIdentity(input);
}

export function parseNativeHostRecoveryRequest(value: unknown): NativeHostRecoveryRequest {
  const input = exactRecord(value, [
    "schemaVersion", "requestId", "hostId", "capacity", "claimId", "attemptId", "descriptorDigest",
    "resourceId", "cleanupComplete"
  ]);
  if (input.schemaVersion !== 1) throw new UserError("native host recovery schemaVersion must be 1");
  if (input.cleanupComplete !== true) throw new UserError("native host recovery requires completed cleanup");
  return { ...parseClaimIdentity(input), resourceId: uuid(input.resourceId, "resource ID"), cleanupComplete: true };
}

export function parseStoredDescriptor(value: string): NativeOrdinaryDescriptor {
  return parseStored(value, parseNativeDescriptor, "descriptor");
}

export function parseStoredEvent(value: string): NativeReviewJobEvent {
  return parseStored(value, parseNativeReviewJobEvent, "event");
}

export function parseStoredPolicy(value: string): NativeAdmissionPolicy {
  return parseStored(value, parseNativeAdmissionPolicy, "admission");
}

export function parseStoredIssuance(value: string): NativeJobAttemptIssuance {
  return parseStored(value, parseNativeJobAttemptIssuance, "issuance");
}

function parseStored<T>(value: string, parser: (input: unknown) => T, label: string): T {
  try {
    return parser(JSON.parse(value));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UserError(`native ordinary database contains malformed ${label} JSON`, { cause: error });
    throw error;
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const input = record(value);
  if (Object.keys(input).length !== keys.length || keys.some((key) => input[key] === undefined)) {
    throw new UserError("request body has invalid fields");
  }
  return input;
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new UserError(`${label} is invalid`);
  return value;
}

function parseClaimIdentity(input: Readonly<Record<string, unknown>>): NativeHostClaimRenewalRequest {
  return {
    schemaVersion: 1,
    requestId: uuid(input.requestId, "request ID"),
    hostId: identifier(input.hostId, "host ID"),
    capacity: identifier(input.capacity, "capacity"),
    claimId: uuid(input.claimId, "claim ID"),
    attemptId: uuid(input.attemptId, "attempt ID"),
    descriptorDigest: digest(input.descriptorDigest)
  };
}

const uuid = (value: unknown, label: string) => text(
  value,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  label
);
const identifier = (value: unknown, label: string) => text(value, /^[a-z0-9][a-z0-9._-]{0,127}$/, label);
const digest = (value: unknown) => text(value, /^sha256:[0-9a-f]{64}$/, "descriptor digest");
