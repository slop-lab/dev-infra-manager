import { UserError } from "./errors.js";
import { nativeDescriptorDigest } from "./nativeOrdinaryAuthorityProtocol.js";
import type {
  NativeAdmissionPolicy,
  NativeAdmissionRevocation,
  NativeAdmissionVerification,
  NativeAttemptAssignment,
  NativeAttemptVerification,
  NativeOrdinaryDescriptor,
  NativeResourceBounds
} from "./nativeOrdinaryAuthorityProtocol.js";
export * from "./nativeOrdinaryAuthorityProtocol.js";

const descriptorKeys = [
  "projectId", "repositoryId", "protectedRef", "expectedProtectedHead", "candidateCommit", "candidateTree",
  "policyRevision", "requiredReviewRevision", "requiredJobSetRevision", "admissionGeneration", "jobName",
  "runnerBaseImage", "bounds", "evidenceClass", "configBlob", "script", "argv", "jobImage"
] as const;

export function parseNativeAdmissionPolicy(value: unknown): NativeAdmissionPolicy {
  const input = exactRecord(value, [
    "schemaVersion", "projectId", "repositoryId", "protectedRef", "policyRevision", "requiredReviewRevision",
    "requiredJobSetRevision", "requiredJobs"
  ]);
  if (input.schemaVersion !== 1) throw new UserError("native ordinary admission schemaVersion must be 1");
  const requiredJobs = stringArray(input.requiredJobs, "required jobs").map((job) => identifier(job, "job name"));
  assertUnique(requiredJobs, "required jobs");
  return {
    schemaVersion: 1,
    projectId: identifier(input.projectId, "Project ID"),
    repositoryId: identifier(input.repositoryId, "repository ID"),
    protectedRef: headRef(input.protectedRef),
    policyRevision: revision(input.policyRevision, "policy revision"),
    requiredReviewRevision: revision(input.requiredReviewRevision, "review revision"),
    requiredJobSetRevision: revision(input.requiredJobSetRevision, "job-set revision"),
    requiredJobs
  };
}

export function parseNativeAttemptAssignment(value: unknown): NativeAttemptAssignment {
  const input = exactRecord(value, [
    "schemaVersion", "reviewId", "attemptId", "descriptor", "descriptorDigest", "admissionGeneration", "hostId", "capacity"
  ]);
  if (input.schemaVersion !== 1) throw new UserError("native ordinary assignment schemaVersion must be 1");
  const descriptor = parseNativeDescriptor(input.descriptor);
  const admissionGeneration = generation(input.admissionGeneration, "admission generation");
  if (descriptor.admissionGeneration !== admissionGeneration) throw new UserError("assignment admission generation does not match descriptor");
  const descriptorDigest = digest(input.descriptorDigest);
  if (nativeDescriptorDigest(descriptor) !== descriptorDigest) throw new UserError("assignment descriptor digest is invalid");
  return {
    schemaVersion: 1,
    reviewId: hex(input.reviewId, 64, "review ID"),
    attemptId: uuid(input.attemptId, "attempt ID"),
    descriptor,
    descriptorDigest,
    admissionGeneration,
    hostId: assignmentIdentifier(input.hostId, "host ID"),
    capacity: assignmentIdentifier(input.capacity, "capacity")
  };
}

export function parseNativeAdmissionVerification(value: unknown): NativeAdmissionVerification {
  const input = exactRecord(value, ["schemaVersion", "requestId", "descriptor", "descriptorDigest", "hostId", "capacity"]);
  const assignment = parseNativeAttemptAssignment({
    schemaVersion: input.schemaVersion,
    descriptor: input.descriptor,
    descriptorDigest: input.descriptorDigest,
    hostId: input.hostId,
    capacity: input.capacity,
    reviewId: "0".repeat(64),
    attemptId: "00000000-0000-4000-8000-000000000000",
    admissionGeneration: record(input.descriptor).admissionGeneration
  });
  return {
    schemaVersion: 1,
    requestId: uuid(input.requestId, "request ID"),
    descriptor: assignment.descriptor,
    descriptorDigest: assignment.descriptorDigest,
    hostId: assignment.hostId,
    capacity: assignment.capacity
  };
}

export function parseNativeAdmissionRevocation(value: unknown): NativeAdmissionRevocation {
  const input = exactRecord(value, ["schemaVersion", "projectId", "repositoryId", "admissionGeneration"]);
  if (input.schemaVersion !== 1) throw new UserError("native ordinary revocation schemaVersion must be 1");
  return {
    schemaVersion: 1,
    projectId: identifier(input.projectId, "Project ID"),
    repositoryId: identifier(input.repositoryId, "repository ID"),
    admissionGeneration: generation(input.admissionGeneration, "admission generation")
  };
}

export function parseNativeAttemptVerification(value: unknown): NativeAttemptVerification {
  const input = exactRecord(value, [
    "schemaVersion", "requestId", "reviewId", "attemptId", "descriptorDigest", "admissionGeneration", "hostId", "capacity"
  ]);
  if (input.schemaVersion !== 1) throw new UserError("native ordinary verification schemaVersion must be 1");
  return {
    schemaVersion: 1,
    requestId: uuid(input.requestId, "request ID"),
    reviewId: hex(input.reviewId, 64, "review ID"),
    attemptId: uuid(input.attemptId, "attempt ID"),
    descriptorDigest: digest(input.descriptorDigest),
    admissionGeneration: generation(input.admissionGeneration, "admission generation"),
    hostId: assignmentIdentifier(input.hostId, "host ID"),
    capacity: assignmentIdentifier(input.capacity, "capacity")
  };
}

export function parseNativeDescriptor(value: unknown): NativeOrdinaryDescriptor {
  const input = exactRecord(value, descriptorKeys);
  const blob = exactRecord(input.configBlob, ["objectId", "sha256"]);
  const script = exactRecord(input.script, ["objectId", "sha256", "path"]);
  const argv = array(input.argv, "argv");
  if (input.evidenceClass !== "candidate-controlled" || JSON.stringify(argv) !== JSON.stringify(["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"])) {
    throw new UserError("native ordinary descriptor execution contract is invalid");
  }
  return {
    projectId: identifier(input.projectId, "Project ID"), repositoryId: identifier(input.repositoryId, "repository ID"),
    protectedRef: headRef(input.protectedRef), expectedProtectedHead: objectId(input.expectedProtectedHead),
    candidateCommit: objectId(input.candidateCommit), candidateTree: objectId(input.candidateTree),
    policyRevision: revision(input.policyRevision, "policy revision"), requiredReviewRevision: revision(input.requiredReviewRevision, "review revision"),
    requiredJobSetRevision: revision(input.requiredJobSetRevision, "job-set revision"), admissionGeneration: generation(input.admissionGeneration, "admission generation"),
    jobName: identifier(input.jobName, "job name"), runnerBaseImage: image(input.runnerBaseImage), bounds: resourceBounds(input.bounds),
    evidenceClass: "candidate-controlled", configBlob: { objectId: objectId(blob.objectId), sha256: digest(blob.sha256) },
    script: { objectId: objectId(script.objectId), sha256: digest(script.sha256), path: scriptPath(script.path) },
    argv: ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"], jobImage: image(input.jobImage)
  };
}

export function resourceBounds(value: unknown): NativeResourceBounds {
  const input = exactRecord(value, ["cpu", "memoryBytes", "pids", "wallClockSeconds", "outputBytes"]);
  return {
    cpu: positiveInteger(input.cpu, "CPU"), memoryBytes: positiveInteger(input.memoryBytes, "memory"),
    pids: positiveInteger(input.pids, "PIDs"), wallClockSeconds: positiveInteger(input.wallClockSeconds, "wall clock"),
    outputBytes: positiveInteger(input.outputBytes, "output")
  };
}

export function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UserError("request body must be an object");
  return value as Readonly<Record<string, unknown>>;
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const input = record(value);
  if (Object.keys(input).length !== keys.length || keys.some((key) => input[key] === undefined)) throw new UserError("request body has invalid fields");
  return input;
}

function resourceString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new UserError(`${label} is invalid`);
  return value;
}

const identifier = (value: unknown, label: string) => resourceString(value, /^[a-z][a-z0-9-]{0,62}$/, label);
const assignmentIdentifier = (value: unknown, label: string) => resourceString(value, /^[a-z0-9][a-z0-9._-]{0,127}$/, label);
const revision = (value: unknown, label: string) => resourceString(value, /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/, label);
const generation = (value: unknown, label: string) => resourceString(value, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, label);
const uuid = (value: unknown, label: string) => resourceString(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, label);
const digest = (value: unknown) => resourceString(value, /^sha256:[0-9a-f]{64}$/, "SHA-256 digest");
const objectId = (value: unknown) => resourceString(value, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "object ID");
const image = (value: unknown) => resourceString(value, /^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/, "image");
const positiveInteger = (value: unknown, label: string) => resourceString(value, /^[1-9][0-9]*$/, label);
const hex = (value: unknown, length: number, label: string) => resourceString(value, new RegExp(`^[0-9a-f]{${length}}$`), label);

function headRef(value: unknown): string {
  const ref = resourceString(value, /^refs\/heads\/.+$/, "protected ref");
  if (ref.endsWith("/") || ref.endsWith(".") || ref.endsWith(".lock") || ref.includes("..") || ref.includes("@{") || /[\\\x00-\x20\x7f~^:?*[\]]/.test(ref)) throw new UserError("protected ref is invalid");
  return ref;
}

function scriptPath(value: unknown): string {
  const path = resourceString(value, /^\.dim\/ci\/jobs\/.+\.bash$/, "script path");
  if (path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new UserError("script path is invalid");
  return path;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new UserError(`${label} must be a non-empty array`);
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  const values = array(value, label);
  if (!values.every((item) => typeof item === "string")) throw new UserError(`${label} must contain strings`);
  return values;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new UserError(`${label} must be unique`);
}
