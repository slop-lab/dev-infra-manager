import { UserError } from "./errors.js";
import { parseNativeDescriptor, record } from "./nativeOrdinaryAuthorityModel.js";
import type { NativeOrdinaryDescriptor } from "./nativeOrdinaryAuthorityProtocol.js";

export type NativeExecutionDescriptor = {
  readonly reviewId: string;
  readonly descriptor: NativeOrdinaryDescriptor;
  readonly digest: string;
};

export type NativeJobAttemptIssuance = {
  readonly schemaVersion: 2;
  readonly issuanceRequestId: string;
  readonly attemptId: string;
  readonly reviewId: string;
  readonly attempt: number;
  readonly descriptor: NativeOrdinaryDescriptor;
  readonly descriptorDigest: string;
  readonly hostId: string;
  readonly capacity: string;
  readonly issuedBy: string;
  readonly issuedAt: string;
};

export type NativeJobAttemptRevocation = {
  readonly schemaVersion: 2;
  readonly revocationId: string;
  readonly attemptId: string;
  readonly reviewId: string;
  readonly jobName: string;
  readonly attempt: number;
  readonly descriptorDigest: string;
  readonly hostId: string;
  readonly capacity: string;
  readonly revokedBy: string;
  readonly revokedAt: string;
};

export function parseNativeExecutionDescriptor(value: unknown): NativeExecutionDescriptor {
  const input = exactRecord(value, ["reviewId", "descriptor", "digest"]);
  return {
    reviewId: reviewDigest(input.reviewId),
    descriptor: parseNativeDescriptor(input.descriptor),
    digest: digest(input.digest)
  };
}

export function parseNativeJobAttemptIssuance(value: unknown): NativeJobAttemptIssuance {
  const input = exactRecord(value, [
    "schemaVersion", "issuanceRequestId", "attemptId", "reviewId", "attempt", "descriptor",
    "descriptorDigest", "hostId", "capacity", "issuedBy", "issuedAt"
  ]);
  if (input.schemaVersion !== 2) throw new UserError("native job attempt schemaVersion must be 2");
  return {
    schemaVersion: 2,
    issuanceRequestId: uuid(input.issuanceRequestId, "issuance request ID"),
    attemptId: uuid(input.attemptId, "attempt ID"),
    reviewId: reviewDigest(input.reviewId),
    attempt: positiveNumber(input.attempt, "attempt"),
    descriptor: parseNativeDescriptor(input.descriptor),
    descriptorDigest: digest(input.descriptorDigest),
    hostId: assignmentIdentifier(input.hostId, "host ID"),
    capacity: assignmentIdentifier(input.capacity, "capacity"),
    issuedBy: username(input.issuedBy, "issuer username"),
    issuedAt: timestamp(input.issuedAt, "issuance timestamp")
  };
}

export function parseNativeJobAttemptRevocation(value: unknown): NativeJobAttemptRevocation {
  const input = exactRecord(value, [
    "schemaVersion", "revocationId", "attemptId", "reviewId", "jobName", "attempt", "descriptorDigest",
    "hostId", "capacity", "revokedBy", "revokedAt"
  ]);
  if (input.schemaVersion !== 2) throw new UserError("native job attempt revocation schemaVersion must be 2");
  return {
    schemaVersion: 2,
    revocationId: uuid(input.revocationId, "revocation ID"),
    attemptId: uuid(input.attemptId, "attempt ID"),
    reviewId: reviewDigest(input.reviewId),
    jobName: identifier(input.jobName, "job name"),
    attempt: positiveNumber(input.attempt, "attempt"),
    descriptorDigest: digest(input.descriptorDigest),
    hostId: assignmentIdentifier(input.hostId, "host ID"),
    capacity: assignmentIdentifier(input.capacity, "capacity"),
    revokedBy: username(input.revokedBy, "revoker username"),
    revokedAt: timestamp(input.revokedAt, "revocation timestamp")
  };
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const input = record(value);
  if (Object.keys(input).length !== keys.length || keys.some((key) => input[key] === undefined)) {
    throw new UserError("native Git response has invalid fields");
  }
  return input;
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new UserError(`${label} is invalid`);
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new UserError(`${label} is invalid`);
  return value;
}

const reviewDigest = (value: unknown) => text(value, /^[0-9a-f]{64}$/, "review ID");
const digest = (value: unknown) => text(value, /^sha256:[0-9a-f]{64}$/, "descriptor digest");
const uuid = (value: unknown, label: string) => text(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, label);
const identifier = (value: unknown, label: string) => text(value, /^[a-z][a-z0-9-]{0,62}$/, label);
const assignmentIdentifier = (value: unknown, label: string) => text(value, /^[a-z0-9][a-z0-9._-]{0,127}$/, label);
const username = (value: unknown, label: string) => text(value, /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/, label);

function timestamp(value: unknown, label: string): string {
  const source = text(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, label);
  const fields = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(source);
  const parsed = new Date(source);
  if (fields === null || Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== Number(fields[1]) || parsed.getUTCMonth() + 1 !== Number(fields[2])
    || parsed.getUTCDate() !== Number(fields[3]) || parsed.getUTCHours() !== Number(fields[4])
    || parsed.getUTCMinutes() !== Number(fields[5]) || parsed.getUTCSeconds() !== Number(fields[6])) {
    throw new UserError(`${label} is invalid`);
  }
  return source;
}
