import { z } from "zod";
import { isCandidatePath, isCandidateArgv } from "./workflowCompiler.js";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const revision = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/);
const generation = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const positiveInteger = z.string().regex(/^[1-9][0-9]*$/);
const image = z.string().regex(/^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/);
const protectedRef = z.string().max(1024).refine((value) => safeHeadRef(value));
const scriptPath = z.string().refine(isCandidatePath);

export const ordinaryExecutionDescriptorRequestFields = {
  admissionGeneration: generation,
  jobName: identifier,
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

export const ordinaryExecutionDescriptorRequestSchema = z.object(ordinaryExecutionDescriptorRequestFields).strict().readonly();

const candidateOrdinaryExecutionDescriptorFields = {
  admissionGeneration: generation,
  jobName: identifier,
  runnerBaseImage: image,
  bounds: ordinaryExecutionDescriptorRequestFields.bounds,
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

export const candidateOrdinaryExecutionDescriptorSchema = z.object({
  ...candidateOrdinaryExecutionDescriptorFields,
  evidenceClass: z.literal("candidate-controlled"),
  configBlob: z.object({ ...blobIdentityFields, path: scriptPath }).strict().readonly(),
  script: z.object({ ...blobIdentityFields, path: scriptPath }).strict().readonly(),
  argv: z.array(z.string()).refine(isCandidateArgv).readonly(),
  jobImage: image
}).strict().readonly();

export type OrdinaryExecutionDescriptorRequest = z.infer<typeof ordinaryExecutionDescriptorRequestSchema>;
export type CandidateOrdinaryExecutionDescriptor = z.infer<typeof candidateOrdinaryExecutionDescriptorSchema>;
export class CandidateExecutionError extends Error {
  readonly name = "CandidateExecutionError";
}

function safeHeadRef(value: string): boolean {
  if (!value.startsWith("refs/heads/") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("\\") || /[\x00-\x20\x7f~^:?*[\]]/.test(value)) return false;
  return value.slice("refs/heads/".length).split("/").every((component) => component.length > 0 && !component.startsWith("."));
}
