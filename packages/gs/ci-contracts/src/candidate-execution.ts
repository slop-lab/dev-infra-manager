import { createHash } from "node:crypto";
import { z } from "zod";
import { repositorySnapshotsSchema } from "@slop-lab/gs-repository-contracts";
import { isCandidateArgv, isCandidatePath } from "./workflow.js";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const jobName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const revision = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/);
const generation = z.string().regex(/^[0-9a-f]{64}$/);
const positiveInteger = z.string().regex(/^[1-9][0-9]*$/);
const image = z.string().regex(/^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/);
const protectedRef = z.string().max(1024).refine(safeHeadRef);
const scriptPath = z.string().refine(isCandidatePath);

export const executionProfileFields = {
  jobBaseImage: image,
  runnerBaseImage: image,
  bounds: z.object({
    cpu: positiveInteger,
    memoryBytes: positiveInteger,
    pids: positiveInteger,
    wallClockSeconds: positiveInteger,
    outputBytes: positiveInteger
  }).strict().readonly()
} as const;

const descriptorFields = {
  generationId: generation,
  jobName,
  runnerBaseImage: image,
  bounds: executionProfileFields.bounds,
  projectId: identifier,
  repositoryId: identifier,
  protectedRef,
  expectedProtectedHead: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  policyRevision: revision,
  requiredReviewRevision: revision,
  requiredJobSetRevision: revision
} as const;

const blobIdentityFields = {
  objectId,
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/)
} as const;

export const executionInputsSchema = repositorySnapshotsSchema;
export type ExecutionInputs = z.infer<typeof executionInputsSchema>;

export const candidateExecutionDescriptorSchema = z.object({
  ...descriptorFields,
  inputs: executionInputsSchema,
  evidenceClass: z.literal("candidate-controlled"),
  configBlob: z.object({ ...blobIdentityFields, path: scriptPath }).strict().readonly(),
  script: z.object({ ...blobIdentityFields, path: scriptPath }).strict().readonly(),
  argv: z.array(z.string()).refine(isCandidateArgv).readonly(),
  jobImage: image
}).strict().readonly();

export type CandidateExecutionDescriptor = z.infer<typeof candidateExecutionDescriptorSchema>;

export function candidateExecutionDescriptorDigest(descriptor: CandidateExecutionDescriptor): string {
  const fields = [
    descriptor.projectId,
    descriptor.repositoryId,
    JSON.stringify(Object.entries(descriptor.inputs).sort(([left], [right]) => left.localeCompare(right))
      .map(([id, snapshot]) => [id, snapshot.commit, snapshot.tree])),
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
  const hash = createHash("sha256").update("dim-job-execution-v2", "ascii");
  for (const field of fields) hash.update(`${Buffer.byteLength(field, "utf8")}:`, "ascii").update(field, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

export class CandidateExecutionError extends Error {
  readonly name = "CandidateExecutionError";
}

function safeHeadRef(value: string): boolean {
  if (!value.startsWith("refs/heads/") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("\\") || /[\x00-\x20\x7f~^:?*[\]]/.test(value)) return false;
  return value.slice("refs/heads/".length).split("/").every((component) => component.length > 0 && !component.startsWith("."));
}
