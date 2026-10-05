import { createHash } from "node:crypto";

export type NativeResourceBounds = {
  readonly cpu: string;
  readonly memoryBytes: string;
  readonly pids: string;
  readonly wallClockSeconds: string;
  readonly outputBytes: string;
};

export type NativeCapacityPolicy = {
  readonly hostId: string;
  readonly capacity: string;
  readonly runnerBaseImage: string;
  readonly bounds: NativeResourceBounds;
};

export type NativeAdmissionPolicy = {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly protectedRef: string;
  readonly policyRevision: string;
  readonly requiredReviewRevision: string;
  readonly requiredJobSetRevision: string;
  readonly requiredJobs: readonly string[];
  readonly eligibleAssignments: readonly { readonly hostId: string; readonly capacity: string }[];
};

export type NativeOrdinaryDescriptor = {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly protectedRef: string;
  readonly expectedProtectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly policyRevision: string;
  readonly requiredReviewRevision: string;
  readonly requiredJobSetRevision: string;
  readonly admissionGeneration: string;
  readonly jobName: string;
  readonly runnerBaseImage: string;
  readonly bounds: NativeResourceBounds;
  readonly evidenceClass: "candidate-controlled";
  readonly configBlob: { readonly objectId: string; readonly sha256: string };
  readonly script: { readonly objectId: string; readonly sha256: string; readonly path: string };
  readonly argv: readonly ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"];
  readonly jobImage: string;
};

export type NativeAttemptAssignment = {
  readonly schemaVersion: 1;
  readonly reviewId: string;
  readonly attemptId: string;
  readonly descriptor: NativeOrdinaryDescriptor;
  readonly descriptorDigest: string;
  readonly admissionGeneration: string;
  readonly hostId: string;
  readonly capacity: string;
};

export type NativeAdmissionVerification = Omit<NativeAttemptAssignment, "reviewId" | "attemptId" | "admissionGeneration"> & {
  readonly requestId: string;
};

export type NativeAttemptVerification = Omit<NativeAttemptAssignment, "descriptor"> & {
  readonly requestId: string;
};

export type NativeAdmissionRevocation = {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly admissionGeneration: string;
};

export function nativeDescriptorDigest(descriptor: NativeOrdinaryDescriptor): string {
  const fields = [
    descriptor.projectId, descriptor.repositoryId, descriptor.protectedRef, descriptor.expectedProtectedHead,
    descriptor.candidateCommit, descriptor.candidateTree, descriptor.policyRevision, descriptor.requiredReviewRevision,
    descriptor.requiredJobSetRevision, descriptor.admissionGeneration, descriptor.jobName, descriptor.evidenceClass,
    descriptor.configBlob.objectId, descriptor.configBlob.sha256, descriptor.script.path, descriptor.script.objectId,
    descriptor.script.sha256, ...descriptor.argv, descriptor.jobImage, descriptor.runnerBaseImage, descriptor.bounds.cpu,
    descriptor.bounds.memoryBytes, descriptor.bounds.pids, descriptor.bounds.wallClockSeconds, descriptor.bounds.outputBytes
  ];
  const hash = createHash("sha256").update("dim-native-ordinary-execution-v1", "ascii");
  for (const field of fields) hash.update(`${Buffer.byteLength(field, "utf8")}:`, "ascii").update(field, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

export function nativePolicyDigest(policy: NativeAdmissionPolicy): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(policy)), "utf8").digest("hex");
}

export function descriptorMatchesPolicy(
  descriptor: NativeOrdinaryDescriptor,
  policy: NativeAdmissionPolicy,
  capacity: NativeCapacityPolicy
): boolean {
  return descriptor.projectId === policy.projectId && descriptor.repositoryId === policy.repositoryId
    && descriptor.protectedRef === policy.protectedRef && descriptor.policyRevision === policy.policyRevision
    && descriptor.requiredReviewRevision === policy.requiredReviewRevision
    && descriptor.requiredJobSetRevision === policy.requiredJobSetRevision
    && policy.requiredJobs.includes(descriptor.jobName) && descriptor.runnerBaseImage === capacity.runnerBaseImage
    && Object.keys(descriptor.bounds).every((key) =>
      BigInt(descriptor.bounds[key as keyof NativeResourceBounds]) <= BigInt(capacity.bounds[key as keyof NativeResourceBounds]));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalValue(Reflect.get(value, key));
  return output;
}
