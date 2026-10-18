import { UserError } from "@slop-lab/dim-core";
import { resourceBounds, type NativeResourceBounds } from "./nativeOrdinaryAuthorityModel.js";
import { parseNativeRootCiReviewEvent, type NativeRootCiReviewEvent } from "./nativeRootCiReviewEvent.js";

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const generationPattern = /^[0-9a-f]{64}$/;
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const objectPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const imagePattern = /^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;

export type NativeRootCiClaimRequest = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly generationId: string;
  readonly hostId: string;
  readonly capacity: string;
};

export type NativeRootCiClaimAdmission = {
  readonly projectId: string;
  readonly repositoryId: "root";
  readonly importNonce: string;
  readonly rootSequence: number;
  readonly protectedRef: string;
  readonly rootCommit: string;
  readonly rootTree: string;
  readonly policyDigest: string;
  readonly capacityConfigDigest: string;
  readonly leaseExpiresAt: number;
};

export type NativeRootCiClaim = {
  readonly schemaVersion: 1;
  readonly serviceId: string;
  readonly generationId: string;
  readonly serviceEpochId: string;
  readonly requestId: string;
  readonly claimId: string;
  readonly issuanceRequestId: string;
  readonly demandId: string;
  readonly admissionGeneration: string;
  readonly eventDigest: string;
  readonly event: NativeRootCiReviewEvent;
  readonly admission: NativeRootCiClaimAdmission;
  readonly hostId: string;
  readonly capacity: string;
  readonly runnerBaseImage: string;
  readonly jobBaseImage: string;
  readonly bounds: NativeResourceBounds;
};

export type NativeRootCiClaimVerificationRequest = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly generationId: string;
  readonly claim: NativeRootCiClaim;
};

export function parseNativeRootCiClaimRequest(value: unknown): NativeRootCiClaimRequest {
  const input = exactRecord(value, ["schemaVersion", "requestId", "generationId", "hostId", "capacity"]);
  if (input.schemaVersion !== 1) invalid("native root CI claim schemaVersion must be 1");
  return {
    schemaVersion: 1,
    requestId: uuid(input.requestId, "request ID"),
    generationId: generation(input.generationId),
    hostId: identifier(input.hostId, "host ID"),
    capacity: identifier(input.capacity, "capacity")
  };
}

export function parseNativeRootCiClaimVerificationRequest(value: unknown): NativeRootCiClaimVerificationRequest {
  const input = exactRecord(value, ["schemaVersion", "requestId", "generationId", "claim"]);
  if (input.schemaVersion !== 1) invalid("native root CI claim verification schemaVersion must be 1");
  return {
    schemaVersion: 1,
    requestId: uuid(input.requestId, "request ID"),
    generationId: generation(input.generationId),
    claim: parseNativeRootCiClaim(input.claim)
  };
}

export function parseNativeRootCiClaim(value: unknown): NativeRootCiClaim {
  const input = exactRecord(value, [
    "schemaVersion", "serviceId", "generationId", "serviceEpochId", "requestId", "claimId",
    "issuanceRequestId", "demandId", "admissionGeneration", "eventDigest", "event", "admission",
    "hostId", "capacity", "runnerBaseImage", "jobBaseImage", "bounds"
  ]);
  if (input.schemaVersion !== 1 || typeof input.serviceId !== "string") invalid("native root CI claim is invalid");
  const claimId = uuid(input.claimId, "claim ID");
  const issuanceRequestId = uuid(input.issuanceRequestId, "issuance request ID");
  if (issuanceRequestId !== claimId) invalid("native root CI claim issuance request must equal claim ID");
  return {
    schemaVersion: 1,
    serviceId: input.serviceId,
    generationId: generation(input.generationId),
    serviceEpochId: uuid(input.serviceEpochId, "service epoch ID"),
    requestId: uuid(input.requestId, "request ID"),
    claimId,
    issuanceRequestId,
    demandId: uuid(input.demandId, "demand ID"),
    admissionGeneration: uuid(input.admissionGeneration, "admission generation"),
    eventDigest: digest(input.eventDigest, "event digest"),
    event: parseNativeRootCiReviewEvent(input.event),
    admission: parseAdmission(input.admission),
    hostId: identifier(input.hostId, "host ID"),
    capacity: identifier(input.capacity, "capacity"),
    runnerBaseImage: image(input.runnerBaseImage),
    jobBaseImage: image(input.jobBaseImage),
    bounds: resourceBounds(input.bounds)
  };
}

function parseAdmission(value: unknown): NativeRootCiClaimAdmission {
  const input = exactRecord(value, ["projectId", "repositoryId", "importNonce", "rootSequence", "protectedRef",
    "rootCommit", "rootTree", "policyDigest", "capacityConfigDigest", "leaseExpiresAt"]);
  if (typeof input.projectId !== "string" || input.repositoryId !== "root"
    || typeof input.rootSequence !== "number" || !Number.isSafeInteger(input.rootSequence) || input.rootSequence < 0
    || typeof input.protectedRef !== "string" || !input.protectedRef.startsWith("refs/heads/")
    || typeof input.leaseExpiresAt !== "number" || !Number.isSafeInteger(input.leaseExpiresAt)
    || input.leaseExpiresAt < 1) invalid("native root CI claim admission is invalid");
  const rootCommit = objectId(input.rootCommit, "root commit");
  const rootTree = objectId(input.rootTree, "root tree");
  if (rootCommit.length !== rootTree.length) invalid("native root CI claim admission is invalid");
  return {
    projectId: input.projectId,
    repositoryId: "root",
    importNonce: uuid(input.importNonce, "import nonce"),
    rootSequence: input.rootSequence,
    protectedRef: input.protectedRef,
    rootCommit,
    rootTree,
    policyDigest: hexDigest(input.policyDigest, "policy digest"),
    capacityConfigDigest: hexDigest(input.capacityConfigDigest, "capacity config digest"),
    leaseExpiresAt: input.leaseExpiresAt
  };
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
const uuid = (value: unknown, label: string) => text(value, uuidV4Pattern, label);
const generation = (value: unknown) => text(value, generationPattern, "generation ID");
const identifier = (value: unknown, label: string) => text(value, identifierPattern, label);
const digest = (value: unknown, label: string) => text(value, digestPattern, label);
const hexDigest = (value: unknown, label: string) => text(value, generationPattern, label);
const objectId = (value: unknown, label: string) => text(value, objectPattern, label);
const image = (value: unknown) => text(value, imagePattern, "image");
function invalid(message: string): never { throw new UserError(message); }
