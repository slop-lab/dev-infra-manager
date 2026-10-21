import { z } from "zod";
import { isCandidatePath, isCandidateArgv } from "./workflow-plugin-api.js";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const jobName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const revision = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/);
const generation = z.string().regex(/^[0-9a-f]{64}$/);
const positiveInteger = z.string().regex(/^[1-9][0-9]*$/);
const image = z.string().regex(/^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/);
const protectedRef = z.string().max(1024).refine((value) => safeHeadRef(value));
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

const candidateExecutionDescriptorFields = {
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

export const executionInputsSchema = z.record(identifier, z.object({ commit: objectId, tree: objectId }).strict().readonly())
  .refine((inputs) => Object.keys(inputs).length > 0 && Object.keys(inputs).length <= 64).readonly();
export type ExecutionInputs = z.infer<typeof executionInputsSchema>;

export const candidateExecutionDescriptorSchema = z.object({
  ...candidateExecutionDescriptorFields,
  inputs: executionInputsSchema,
  evidenceClass: z.literal("candidate-controlled"),
  configBlob: z.object({ ...blobIdentityFields, path: scriptPath }).strict().readonly(),
  script: z.object({ ...blobIdentityFields, path: scriptPath }).strict().readonly(),
  argv: z.array(z.string()).refine(isCandidateArgv).readonly(),
  jobImage: image
}).strict().readonly();

export type CandidateExecutionDescriptor = z.infer<typeof candidateExecutionDescriptorSchema>;
export class CandidateExecutionError extends Error {
  readonly name = "CandidateExecutionError";
}

function safeHeadRef(value: string): boolean {
  if (!value.startsWith("refs/heads/") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("\\") || /[\x00-\x20\x7f~^:?*[\]]/.test(value)) return false;
  return value.slice("refs/heads/".length).split("/").every((component) => component.length > 0 && !component.startsWith("."));
}
