import { createHash } from "node:crypto";
import { z } from "zod";
import { candidateArgv } from "./candidate-execution-schema.js";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const revision = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/);
const generation = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const positiveInteger = z.string().regex(/^[1-9][0-9]*$/);
const image = z.string().regex(/^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/);
const protectedRef = z.string().max(1024).refine((value) => safeHeadRef(value));
const scriptPath = z.string().refine((value) => value.startsWith(".dim/ci/jobs/")
  && value.endsWith(".bash") && !value.includes("\\")
  && value.split("/").every((component) => component.length > 0 && component !== "." && component !== ".."));
const blobIdentity = z.object({
  objectId,
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/)
}).strict().readonly();

export const qemuExecutionDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  executionKind: z.literal("qemu"),
  admissionGeneration: generation,
  jobName: identifier,
  runnerBaseImage: image,
  bounds: z.object({
    cpu: positiveInteger,
    memoryBytes: positiveInteger,
    pids: positiveInteger,
    wallClockSeconds: positiveInteger,
    outputBytes: positiveInteger
  }).strict().readonly(),
  projectId: identifier,
  repositoryId: identifier,
  protectedRef,
  expectedProtectedHead: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  policyRevision: revision,
  requiredReviewRevision: revision,
  requiredJobSetRevision: revision,
  evidenceClass: z.literal("candidate-controlled"),
  configBlob: blobIdentity,
  script: z.object({
    path: scriptPath,
    objectId,
    sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/)
  }).strict().readonly(),
  argv: z.tuple([
    z.literal(candidateArgv[0]),
    z.literal(candidateArgv[1]),
    z.literal(candidateArgv[2]),
    z.literal(candidateArgv[3])
  ]).readonly(),
  jobImage: image
}).strict().readonly();

export type QemuExecutionDescriptor = z.infer<typeof qemuExecutionDescriptorSchema>;

export function qemuExecutionDescriptorDigest(descriptor: QemuExecutionDescriptor): string {
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
    descriptor.admissionGeneration,
    descriptor.jobName,
    descriptor.evidenceClass,
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
  const hash = createHash("sha256").update("dim-native-qemu-execution-v1", "ascii");
  for (const field of fields) hash.update(`${Buffer.byteLength(field, "utf8")}:`, "ascii").update(field, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function safeHeadRef(value: string): boolean {
  if (!value.startsWith("refs/heads/") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) {
    return false;
  }
  if (value.includes("..") || value.includes("@{") || value.includes("\\")
    || /[\x00-\x20\x7f~^:?*[\]]/.test(value)) return false;
  return value.slice("refs/heads/".length).split("/")
    .every((component) => component.length > 0 && !component.startsWith("."));
}
