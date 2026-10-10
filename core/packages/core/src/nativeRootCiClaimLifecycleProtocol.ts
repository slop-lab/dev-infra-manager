import { isDeepStrictEqual } from "node:util";
import { UserError } from "./errors.js";
import {
  parseNativeJobAttemptIssuance,
  type NativeJobAttemptIssuance
} from "./nativeGitAttemptIssuerModel.js";
import {
  parseNativeAttemptAssignment,
  type NativeAttemptAssignment
} from "./nativeOrdinaryAuthorityModel.js";
import {
  parseNativeRootCiClaim,
  type NativeRootCiClaim
} from "./nativeRootCiClaimProtocol.js";

export type NativeRootCiClaimActivationRequest = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly generationId: string;
  readonly claim: NativeRootCiClaim;
  readonly issuance: NativeJobAttemptIssuance;
};

export type NativeRootCiClaimLeaseRequest = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly generationId: string;
  readonly hostId: string;
  readonly capacity: string;
  readonly claimId: string;
  readonly attemptId: string;
  readonly descriptorDigest: string;
};

export type NativeRootCiClaimRecoveryRequest = NativeRootCiClaimLeaseRequest & {
  readonly claim: NativeRootCiClaim;
  readonly issuance: NativeJobAttemptIssuance;
  readonly resourceId: string;
  readonly cleanupComplete: true;
};

export type NativeRootCiActiveClaim = {
  readonly schemaVersion: 1;
  readonly serviceId: string;
  readonly generationId: string;
  readonly serviceEpochId: string;
  readonly requestId: string;
  readonly claimId: string;
  readonly assignment: NativeAttemptAssignment;
  readonly issuance: NativeJobAttemptIssuance;
  readonly leaseExpiresAt: number;
  readonly leaseDurationMilliseconds: number;
};

export function parseNativeRootCiClaimActivationRequest(value: unknown): NativeRootCiClaimActivationRequest {
  const input = exactRecord(value, ["schemaVersion", "requestId", "generationId", "claim", "issuance"]);
  if (input.schemaVersion !== 1) invalid("native root CI claim activation schemaVersion must be 1");
  const claim = parseNativeRootCiClaim(input.claim);
  const issuance = parseNativeJobAttemptIssuance(input.issuance);
  assertIssuanceBinding(claim, issuance);
  return { schemaVersion: 1, requestId: uuid(input.requestId, "request ID"),
    generationId: generation(input.generationId), claim, issuance };
}

export function parseNativeRootCiClaimLeaseRequest(value: unknown): NativeRootCiClaimLeaseRequest {
  const input = exactRecord(value, ["schemaVersion", "requestId", "generationId", "hostId", "capacity",
    "claimId", "attemptId", "descriptorDigest"]);
  if (input.schemaVersion !== 1) invalid("native root CI claim lease schemaVersion must be 1");
  return parseLeaseIdentity(input);
}

export function parseNativeRootCiClaimRecoveryRequest(value: unknown): NativeRootCiClaimRecoveryRequest {
  const input = exactRecord(value, ["schemaVersion", "requestId", "generationId", "hostId", "capacity",
    "claimId", "attemptId", "descriptorDigest", "claim", "issuance", "resourceId", "cleanupComplete"]);
  if (input.schemaVersion !== 1) invalid("native root CI claim recovery schemaVersion must be 1");
  if (input.cleanupComplete !== true) invalid("native root CI claim recovery requires completed cleanup");
  const identity = parseLeaseIdentity(input);
  const claim = parseNativeRootCiClaim(input.claim);
  const issuance = parseNativeJobAttemptIssuance(input.issuance);
  assertIssuanceBinding(claim, issuance);
  if (identity.hostId !== claim.hostId || identity.capacity !== claim.capacity || identity.claimId !== claim.claimId
    || identity.attemptId !== issuance.attemptId || identity.descriptorDigest !== issuance.descriptorDigest) {
    invalid("native root CI claim recovery identity conflicts");
  }
  return { ...identity, claim, issuance, resourceId: uuid(input.resourceId, "resource ID"), cleanupComplete: true };
}

export function nativeRootCiAttemptAssignment(
  claim: NativeRootCiClaim,
  issuance: NativeJobAttemptIssuance
): NativeAttemptAssignment {
  assertIssuanceBinding(claim, issuance);
  return parseNativeAttemptAssignment({ schemaVersion: 1, reviewId: issuance.reviewId,
    attemptId: issuance.attemptId, descriptor: issuance.descriptor,
    descriptorDigest: issuance.descriptorDigest, admissionGeneration: claim.admissionGeneration,
    hostId: issuance.hostId, capacity: issuance.capacity });
}

export function parseNativeRootCiActiveClaim(value: unknown): NativeRootCiActiveClaim {
  const input = exactRecord(value, ["schemaVersion", "serviceId", "generationId", "serviceEpochId", "requestId",
    "claimId", "assignment", "issuance", "leaseExpiresAt", "leaseDurationMilliseconds"]);
  if (input.schemaVersion !== 1 || typeof input.serviceId !== "string") {
    invalid("native root CI active claim is invalid");
  }
  const leaseExpiresAt = positiveInteger(input.leaseExpiresAt, "lease expiry");
  const leaseDurationMilliseconds = positiveInteger(input.leaseDurationMilliseconds, "lease duration");
  return { schemaVersion: 1, serviceId: input.serviceId, generationId: generation(input.generationId),
    serviceEpochId: uuid(input.serviceEpochId, "service epoch ID"), requestId: uuid(input.requestId, "request ID"),
    claimId: uuid(input.claimId, "claim ID"), assignment: parseNativeAttemptAssignment(input.assignment),
    issuance: parseNativeJobAttemptIssuance(input.issuance), leaseExpiresAt, leaseDurationMilliseconds };
}

function assertIssuanceBinding(claim: NativeRootCiClaim, issuance: NativeJobAttemptIssuance): void {
  if (issuance.issuanceRequestId !== claim.issuanceRequestId || issuance.reviewId !== claim.event.reviewId
    || issuance.hostId !== claim.hostId || issuance.capacity !== claim.capacity
    || issuance.descriptor.admissionGeneration !== claim.admissionGeneration
    || issuance.descriptor.projectId !== claim.event.projectId || issuance.descriptor.repositoryId !== "root"
    || issuance.descriptor.jobName !== claim.event.jobName || issuance.descriptor.jobImage !== claim.jobBaseImage
    || issuance.descriptor.runnerBaseImage !== claim.runnerBaseImage
    || !isDeepStrictEqual(issuance.descriptor.bounds, claim.bounds)) {
    invalid("native root CI attempt issuance conflicts with reservation claim");
  }
}

function parseLeaseIdentity(input: Readonly<Record<string, unknown>>): NativeRootCiClaimLeaseRequest {
  return { schemaVersion: 1, requestId: uuid(input.requestId, "request ID"), generationId: generation(input.generationId),
    hostId: identifier(input.hostId, "host ID"), capacity: identifier(input.capacity, "capacity"),
    claimId: uuid(input.claimId, "claim ID"), attemptId: uuid(input.attemptId, "attempt ID"),
    descriptorDigest: digest(input.descriptorDigest) };
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
const uuid = (value: unknown, label: string) => text(value,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, label);
const generation = (value: unknown) => text(value, /^[0-9a-f]{64}$/, "generation ID");
const identifier = (value: unknown, label: string) => text(value, /^[a-z0-9][a-z0-9._-]{0,127}$/, label);
const digest = (value: unknown) => text(value, /^sha256:[0-9a-f]{64}$/, "descriptor digest");
function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(`${label} is invalid`);
  return value;
}
function invalid(message: string): never { throw new UserError(message); }
