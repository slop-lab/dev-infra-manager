import { isScalar, parseDocument, visit } from "yaml";
import { z } from "zod";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const revision = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/);
const generation = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const positiveInteger = z.string().regex(/^[1-9][0-9]*$/);
const image = z.string().regex(/^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/);
const protectedRef = z.string().max(1024).refine((value) => safeHeadRef(value));
const scriptPath = z.string().refine((value) => {
  if (!value.startsWith(".dim/ci/jobs/") || !value.endsWith(".bash") || value.includes("\\")) return false;
  return value.split("/").every((component) => component.length > 0 && component !== "." && component !== "..");
});

export const candidateArgv = ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"] as const;

const candidateJobSchema = z.object({
  image,
  script: scriptPath,
  argv: z.tuple([
    z.literal(candidateArgv[0]),
    z.literal(candidateArgv[1]),
    z.literal(candidateArgv[2]),
    z.literal(candidateArgv[3])
  ]).readonly()
}).strict().readonly();

const candidateConfigSchema = z.object({
  schemaVersion: z.literal(2),
  ordinary: z.object({
    jobs: z.record(identifier, candidateJobSchema)
  }).strict().readonly()
}).strict().readonly();

export const candidateOrdinaryExecutionRequestSchema = z.object({
  projectId: identifier,
  repositoryId: identifier,
  protectedRef,
  expectedProtectedHead: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  policyRevision: revision,
  requiredReviewRevision: revision,
  requiredJobSetRevision: revision,
  admissionGeneration: generation,
  jobName: identifier,
  runnerBaseImage: image,
  bounds: z.object({
    cpu: positiveInteger,
    memoryBytes: positiveInteger,
    pids: positiveInteger,
    wallClockSeconds: positiveInteger,
    outputBytes: positiveInteger
  }).strict().readonly()
}).strict().readonly();

export type CandidateOrdinaryExecutionRequest = z.infer<typeof candidateOrdinaryExecutionRequestSchema>;
export type CandidateJob = z.infer<typeof candidateJobSchema>;

export function parseCandidateConfig(bytes: Buffer): Readonly<Record<string, CandidateJob>> {
  if (bytes.length > 64 * 1024) throw new CandidateExecutionError("candidate runner config exceeds 64 KiB");
  if (bytes.includes(0)) throw new CandidateExecutionError("candidate runner config contains NUL");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw new CandidateExecutionError("candidate runner config is not UTF-8", { cause: error });
    throw error;
  }
  const document = parseDocument(source, {
    keepSourceTokens: true,
    merge: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
    version: "1.2"
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new CandidateExecutionError("candidate runner config is not strict YAML");
  }
  visit(document, {
    Alias() {
      throw new CandidateExecutionError("candidate runner config contains an alias");
    },
    Node(_key, node) {
      if (node.anchor !== undefined) throw new CandidateExecutionError("candidate runner config contains an anchor");
      if (node.tag !== undefined) throw new CandidateExecutionError("candidate runner config contains an explicit tag");
    },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new CandidateExecutionError("candidate runner config contains a non-string mapping key");
      }
      if (pair.key.value === "<<") {
        throw new CandidateExecutionError("candidate runner config contains a merge key");
      }
    }
  });
  const parsed = candidateConfigSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!parsed.success) throw new CandidateExecutionError("candidate runner config has an invalid schema", { cause: parsed.error });
  const jobs = parsed.data.ordinary.jobs;
  const count = Object.keys(jobs).length;
  if (count < 1 || count > 64) throw new CandidateExecutionError("candidate runner config must define 1 to 64 jobs");
  return jobs;
}

export class CandidateExecutionError extends Error {
  readonly name = "CandidateExecutionError";
}

function safeHeadRef(value: string): boolean {
  if (!value.startsWith("refs/heads/") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("\\") || /[\x00-\x20\x7f~^:?*[\]]/.test(value)) return false;
  return value.slice("refs/heads/".length).split("/").every((component) => component.length > 0 && !component.startsWith("."));
}
