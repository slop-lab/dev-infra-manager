import { createHash } from "node:crypto";
import type { NativeGitReviewPolicy, NativeGitServiceConfig } from "./config.js";
import { assertCandidateObjects, openCandidateGitReader, readCandidateBlob } from "./candidate-execution-git.js";
import {
  candidateArgv,
  candidateOrdinaryExecutionDescriptorSchema,
  candidateOrdinaryExecutionRequestSchema,
  CandidateExecutionError,
  parseCandidateConfig,
  type CandidateOrdinaryExecutionDescriptor,
  type CandidateOrdinaryExecutionRequest
} from "./candidate-execution-schema.js";

const configPath = ".dim/ci/runner.yml";
const evidenceClass = "candidate-controlled" as const;
const descriptorDomain = "dim-native-ordinary-execution-v1";

export type CandidateOrdinaryExecution = {
  readonly descriptor: CandidateOrdinaryExecutionDescriptor;
  readonly digest: string;
};

export async function loadCandidateOrdinaryExecution(
  config: NativeGitServiceConfig,
  input: CandidateOrdinaryExecutionRequest
): Promise<CandidateOrdinaryExecution> {
  const request = candidateOrdinaryExecutionRequestSchema.safeParse(input);
  if (!request.success) throw new CandidateExecutionError("candidate execution request is invalid", { cause: request.error });
  const policy = findPolicy(config, request.data);
  const reader = await openCandidateGitReader(config, request.data.projectId, request.data.repositoryId);
  await assertCandidateObjects(reader, request.data);
  const configBlob = await readCandidateBlob(reader, request.data.candidateTree, configPath, 64 * 1024);
  const jobs = parseCandidateConfig(configBlob.bytes);
  assertExactJobs(jobs, policy.requiredJobNames);
  const job = jobs[request.data.jobName];
  if (job === undefined) throw new CandidateExecutionError("candidate runner config does not define the requested job");
  const scriptBlob = await readCandidateBlob(reader, request.data.candidateTree, job.script, 1024 * 1024);
  const descriptor = candidateOrdinaryExecutionDescriptorSchema.parse({
    ...request.data,
    evidenceClass,
    configBlob: { objectId: configBlob.objectId, sha256: sha256(configBlob.bytes) },
    script: { path: job.script, objectId: scriptBlob.objectId, sha256: sha256(scriptBlob.bytes) },
    argv: candidateArgv,
    jobImage: job.image
  });
  return { descriptor, digest: descriptorDigest(descriptor) };
}

function findPolicy(
  config: NativeGitServiceConfig,
  request: CandidateOrdinaryExecutionRequest
): NativeGitReviewPolicy {
  const repository = config.repositories.find((candidate) =>
    candidate.projectId === request.projectId && candidate.repositoryId === request.repositoryId
  );
  const policy = repository?.reviewPolicies?.find((candidate) => candidate.protectedRef === request.protectedRef);
  if (policy === undefined) throw new CandidateExecutionError("candidate execution does not match a registered policy");
  if (policy.policyRevision !== request.policyRevision
    || policy.requiredReviewRevision !== request.requiredReviewRevision
    || policy.requiredJobSetRevision !== request.requiredJobSetRevision) {
    throw new CandidateExecutionError("candidate execution policy revisions are stale");
  }
  return policy;
}

function assertExactJobs(jobs: Readonly<Record<string, unknown>>, requiredJobs: readonly string[]): void {
  const actual = Object.keys(jobs).sort();
  const required = [...requiredJobs].sort();
  if (actual.length !== required.length || actual.some((name, index) => name !== required[index])) {
    throw new CandidateExecutionError("candidate runner jobs do not equal the protected policy job set");
  }
}

export function descriptorDigest(descriptor: CandidateOrdinaryExecutionDescriptor): string {
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
  const hash = createHash("sha256").update(descriptorDomain, "ascii");
  for (const field of fields) hash.update(`${Buffer.byteLength(field, "utf8")}:`, "ascii").update(field, "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
