import { createHash } from "node:crypto";
import type { CandidateExecutionDescriptor } from "./candidate-execution-schema.js";

const descriptorDomain = "dim-job-execution-v1";

export function descriptorDigest(descriptor: CandidateExecutionDescriptor): string {
  const fields = [
    descriptor.projectId,
    descriptor.repositoryId,
    descriptor.protectedRef,
    descriptor.expectedProtectedHead,
    descriptor.candidateCommit,
    descriptor.candidateTree,
    descriptor.policyRevision,
    descriptor.requiredReviewRevision,
    descriptor.requiredJobSetRevision,
    descriptor.generationId,
    descriptor.jobName,
    descriptor.evidenceClass,
    descriptor.configBlob.path,
    descriptor.configBlob.objectId,
    descriptor.configBlob.sha256,
    descriptor.script.path,
    descriptor.script.objectId,
    descriptor.script.sha256,
    ...descriptor.argv,
    descriptor.jobImage,
    descriptor.runnerBaseImage,
    descriptor.bounds.cpu,
    descriptor.bounds.memoryBytes,
    descriptor.bounds.pids,
    descriptor.bounds.wallClockSeconds,
    descriptor.bounds.outputBytes
  ];
  const hash = createHash("sha256").update(descriptorDomain, "ascii");
  for (const field of fields) hash.update(`${Buffer.byteLength(field, "utf8")}:`, "ascii").update(field, "utf8");
  return `sha256:${hash.digest("hex")}`;
}
