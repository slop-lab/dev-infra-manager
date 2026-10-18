import { isCandidatePath } from "./nativeCandidatePath.js";
import { createHash } from "node:crypto";
import type { NativeQemuConnection } from "./nativeQemuConnection.js";
import { parseNativeQemuReviewEvent } from "./nativeQemuReviewEvent.js";

export type NativeQemuHostAssignment = {
  readonly claim: Readonly<Record<string, unknown>>;
  readonly attempt: {
    readonly attemptId: string;
    readonly descriptorDigest: string;
    readonly descriptor: NativeQemuDescriptor;
  };
};

type ExpectedAssignment = {
  readonly connection: NativeQemuConnection;
  readonly capacity: string;
  readonly requestId: string;
};

const claimFields = ["claimId", "requestId", "hostId", "capacity", "admissionGeneration", "leaseExpiresAt", "event"] as const;
const attemptFields = ["attemptId", "descriptorDigest", "descriptor"] as const;
const descriptorFields = ["schemaVersion", "executionKind", "admissionGeneration", "jobName", "runnerBaseImage",
  "bounds", "projectId", "repositoryId", "protectedRef", "expectedProtectedHead", "candidateCommit", "candidateTree",
  "policyRevision", "requiredReviewRevision", "requiredJobSetRevision", "evidenceClass", "configBlob", "script", "argv",
  "jobImage"] as const;

export function parseNativeQemuHostAssignment(value: unknown, expected: ExpectedAssignment): NativeQemuHostAssignment {
  const root = exact(value, ["schemaVersion", "serviceId", "claim", "attempt"]);
  if (root.schemaVersion !== 1 || root.serviceId !== "qemu-main") invalid();
  const claim = exact(root.claim, claimFields);
  const event = parseNativeQemuReviewEvent(claim.event);
  const capacity = expected.connection.capacities.find((entry) => entry.capacity === expected.capacity);
  if (capacity === undefined || uuid(claim.claimId) === "" || claim.requestId !== expected.requestId
    || claim.hostId !== expected.connection.hostId || claim.capacity !== expected.capacity
    || typeof claim.leaseExpiresAt !== "number" || !Number.isSafeInteger(claim.leaseExpiresAt)) invalid();
  const attempt = exact(root.attempt, attemptFields);
  const descriptor = parseNativeQemuDescriptor(attempt.descriptor);
  const descriptorDigest = digest(attempt.descriptorDigest);
  if (nativeQemuDescriptorDigest(descriptor) !== descriptorDigest
    || descriptor.admissionGeneration !== claim.admissionGeneration
    || descriptor.jobName !== event.jobName || descriptor.projectId !== event.projectId
    || descriptor.repositoryId !== event.repositoryId || descriptor.protectedRef !== event.protectedRef
    || descriptor.expectedProtectedHead !== event.expectedProtectedHead
    || descriptor.candidateCommit !== event.candidateCommit || descriptor.candidateTree !== event.candidateTree
    || descriptor.policyRevision !== event.policyRevision
    || descriptor.requiredReviewRevision !== event.requiredReviewRevision
    || descriptor.requiredJobSetRevision !== event.qualityRevision
    || descriptor.evidenceClass !== event.evidenceClass || descriptor.runnerBaseImage !== capacity.runnerBaseImage
    || descriptor.jobImage !== capacity.jobBaseImage || descriptor.bounds.cpu !== String(capacity.cpus)
    || descriptor.bounds.memoryBytes !== String(capacity.memoryBytes) || descriptor.bounds.pids !== String(capacity.pids)
    || descriptor.bounds.wallClockSeconds !== String(capacity.timeoutSeconds)
    || descriptor.bounds.outputBytes !== String(capacity.outputBytes)) invalid();
  return { claim: { ...claim, event }, attempt: { attemptId: uuid(attempt.attemptId), descriptorDigest,
    descriptor } };
}

export type NativeQemuDescriptor = {
  readonly [key: string]: unknown;
  readonly schemaVersion: 1;
  readonly executionKind: "qemu";
  readonly admissionGeneration: string;
  readonly jobName: string;
  readonly runnerBaseImage: string;
  readonly bounds: { readonly cpu: string; readonly memoryBytes: string; readonly pids: string;
    readonly wallClockSeconds: string; readonly outputBytes: string };
  readonly projectId: string;
  readonly repositoryId: string;
  readonly protectedRef: string;
  readonly expectedProtectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly policyRevision: string;
  readonly requiredReviewRevision: string;
  readonly requiredJobSetRevision: string;
  readonly evidenceClass: string;
  readonly configBlob: { readonly path: string; readonly objectId: string; readonly sha256: string };
  readonly script: { readonly path: string; readonly objectId: string; readonly sha256: string };
  readonly argv: readonly string[];
  readonly jobImage: string;
};

export function parseNativeQemuDescriptor(value: unknown): NativeQemuDescriptor {
  const descriptor = exact(value, descriptorFields);
  const bounds = exact(descriptor.bounds, ["cpu", "memoryBytes", "pids", "wallClockSeconds", "outputBytes"]);
  const configBlob = exact(descriptor.configBlob, ["path", "objectId", "sha256"]);
  const script = exact(descriptor.script, ["path", "objectId", "sha256"]);
  if (descriptor.schemaVersion !== 1 || descriptor.executionKind !== "qemu"
    || descriptor.evidenceClass !== "candidate-controlled" || !Array.isArray(descriptor.argv)
    || JSON.stringify(descriptor.argv) !== JSON.stringify(["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"])) invalid();
  const scriptPath = string(script.path);
  if (!isCandidatePath(scriptPath)) invalid();
  return { ...descriptor, schemaVersion: 1, executionKind: "qemu",
    admissionGeneration: matching(descriptor.admissionGeneration, generationPattern),
    jobName: matching(descriptor.jobName, identifierPattern), runnerBaseImage: matching(descriptor.runnerBaseImage, imagePattern),
    bounds: { cpu: decimal(bounds.cpu), memoryBytes: decimal(bounds.memoryBytes), pids: decimal(bounds.pids),
      wallClockSeconds: decimal(bounds.wallClockSeconds), outputBytes: decimal(bounds.outputBytes) },
    projectId: matching(descriptor.projectId, identifierPattern), repositoryId: matching(descriptor.repositoryId, identifierPattern),
    protectedRef: string(descriptor.protectedRef), expectedProtectedHead: objectId(descriptor.expectedProtectedHead),
    candidateCommit: objectId(descriptor.candidateCommit), candidateTree: objectId(descriptor.candidateTree),
    policyRevision: revision(descriptor.policyRevision), requiredReviewRevision: revision(descriptor.requiredReviewRevision),
    requiredJobSetRevision: revision(descriptor.requiredJobSetRevision), evidenceClass: "candidate-controlled",
    configBlob: { path: candidatePath(configBlob.path), objectId: objectId(configBlob.objectId), sha256: digest(configBlob.sha256) },
    script: { path: scriptPath, objectId: objectId(script.objectId), sha256: digest(script.sha256) },
    argv: descriptor.argv.map(string), jobImage: matching(descriptor.jobImage, imagePattern) };
}

export function nativeQemuDescriptorDigest(descriptor: NativeQemuDescriptor): string {
  const fields = [descriptor.projectId, descriptor.repositoryId, descriptor.protectedRef,
    descriptor.expectedProtectedHead, descriptor.candidateCommit, descriptor.candidateTree, descriptor.policyRevision,
    descriptor.requiredReviewRevision, descriptor.requiredJobSetRevision, descriptor.admissionGeneration,
    descriptor.jobName, descriptor.evidenceClass, descriptor.configBlob.path, descriptor.configBlob.objectId, descriptor.configBlob.sha256,
    descriptor.script.path, descriptor.script.objectId, descriptor.script.sha256, ...descriptor.argv,
    descriptor.jobImage, descriptor.runnerBaseImage, descriptor.bounds.cpu, descriptor.bounds.memoryBytes,
    descriptor.bounds.pids, descriptor.bounds.wallClockSeconds, descriptor.bounds.outputBytes];
  const hash = createHash("sha256").update("dim-native-qemu-execution-v1", "ascii");
  for (const field of fields) hash.update(`${Buffer.byteLength(field, "utf8")}:`, "ascii").update(field, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

const identifierPattern = /^[a-z][a-z0-9-]{0,62}$/;
const generationPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const imagePattern = /^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;
function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))) invalid();
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)]));
}
function string(value: unknown): string { if (typeof value !== "string") invalid(); return value; }
function matching(value: unknown, pattern: RegExp): string { const parsed = string(value); if (!pattern.test(parsed)) invalid(); return parsed; }
function uuid(value: unknown): string { return matching(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); }
function digest(value: unknown): string { return matching(value, /^sha256:[0-9a-f]{64}$/); }
function objectId(value: unknown): string { return matching(value, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/); }
function revision(value: unknown): string { return matching(value, /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/); }
function decimal(value: unknown): string { return matching(value, /^[1-9][0-9]*$/); }
function invalid(): never { throw new NativeQemuAssignmentError("native QEMU assignment is invalid"); }
export class NativeQemuAssignmentError extends Error { readonly name = "NativeQemuAssignmentError"; }

function candidatePath(value: unknown): string {
  const path = string(value);
  if (!isCandidatePath(path)) invalid();
  return path;
}
