import { UserError } from "./errors.js";
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
  readonly admissionGeneration: string;
  readonly hostId: string;
  readonly capacity: string;
  readonly leaseExpiresAt: number;
  readonly descriptor: NativeOrdinaryDescriptor;
  readonly descriptorDigest: string;
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

export function parseStoredDescriptor(value: string): NativeOrdinaryDescriptor {
  return parseStored(value, parseNativeDescriptor, "descriptor");
}

export function parseStoredEvent(value: string): NativeReviewJobEvent {
  return parseStored(value, parseNativeReviewJobEvent, "event");
}

export function parseStoredPolicy(value: string): NativeAdmissionPolicy {
  return parseStored(value, parseNativeAdmissionPolicy, "admission");
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

const uuid = (value: unknown, label: string) => text(
  value,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  label
);
const identifier = (value: unknown, label: string) => text(value, /^[a-z0-9][a-z0-9._-]{0,127}$/, label);
