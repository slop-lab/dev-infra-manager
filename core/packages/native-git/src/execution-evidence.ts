import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { executionGrantSchema, executionGrantRequestSchema, executionResultSchema,
  type ExecutionGrant, type ExecutionResult } from "./execution-protocol.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import { loadAuthoritativeExecutionReview, loadCurrentAuthoritativeExecutionInputs } from "./authoritative-execution-review-inputs.js";
import { candidateExecutionDescriptorSchema } from "./candidate-execution-schema.js";
import { descriptorDigest } from "./candidate-execution.js";
import { ownedReviewDirectory, readReviewJson as readStoredJson, writeImmutableReviewRecord } from "./review-record-storage.js";

export async function authorizeExecution(runtime: AuthoritativeNativeCandidateRuntime, value: unknown): Promise<ExecutionGrant> {
  const request = executionGrantRequestSchema.parse(value);
  if (request.generationId !== runtime.expectedGenerationId) throw new ExecutionConflictError("execution generation is stale");
  const snapshot = await loadAuthoritativeExecutionReview(runtime, request.event);
  const { inputs, review } = await loadCurrentAuthoritativeExecutionInputs(runtime, snapshot);
  const event = snapshot.envelope.events.find((event) => event.eventId === request.event.eventId);
  if (event === undefined || !isDeepStrictEqual(event, request.event)) throw new ExecutionConflictError("execution event is stale");
  const job = inputs.plan.find((job) => job.name === event.jobName && job.kind === event.executionKind);
  if (job === undefined || inputs.configBlob === null) throw new ExecutionConflictError("execution job is missing");
  const root = join(snapshot.target.repository, "dim-execution-grants");
  await ownedReviewDirectory(root);
  const existing = await readOptional(join(root, `${request.executionId}.json`));
  if (existing !== undefined) {
    const grant = executionGrantSchema.parse(existing);
    const { attempt: _attempt, issuedAt: _issuedAt, descriptor: _descriptor, descriptorDigest: _digest, ...original } = grant;
    if (!isDeepStrictEqual(original, request)) throw new ExecutionConflictError("execution identity conflicts");
    await assertCurrentExecution(runtime, grant);
    return grant;
  }
  const history = await grants(snapshot.target.repository);
  const attempt = history.filter((grant) => sameJob(grant, event)).reduce((max, grant) => Math.max(max, grant.attempt), 0) + 1;
  const descriptor = candidateExecutionDescriptorSchema.parse({
    projectId: review.projectId, repositoryId: "root", protectedRef: review.protectedRef,
    expectedProtectedHead: review.expectedProtectedHead, candidateCommit: review.candidateCommit, candidateTree: review.candidateTree,
    policyRevision: review.policyRevision, requiredReviewRevision: review.requiredReviewRevision,
    requiredJobSetRevision: snapshot.envelope.qualityRevision, generationId: runtime.expectedGenerationId,
    jobName: job.name, evidenceClass: "candidate-controlled", configBlob: inputs.configBlob, script: job.script,
    argv: job.argv, runnerBaseImage: request.profile.runnerBaseImage, jobImage: request.profile.jobBaseImage,
    bounds: request.profile.bounds
  });
  const grant = executionGrantSchema.parse({ ...request, attempt, issuedAt: new Date().toISOString(),
    descriptor, descriptorDigest: descriptorDigest(descriptor) });
  await writeImmutableReviewRecord(join(root, `${request.executionId}.json`), grant);
  return grant;
}

export async function readExecutionGrant(repository: string, executionId: string): Promise<ExecutionGrant | undefined> {
  if (!/^[0-9a-f-]{36}$/.test(executionId)) throw new ExecutionConflictError("execution ID is invalid");
  const value = await readOptional(join(repository, "dim-execution-grants", `${executionId}.json`));
  return value === undefined ? undefined : executionGrantSchema.parse(value);
}

export async function assertCurrentExecution(runtime: AuthoritativeNativeCandidateRuntime, grant: ExecutionGrant): Promise<string> {
  if (grant.generationId !== runtime.expectedGenerationId) throw new ExecutionConflictError("execution generation is stale");
  const snapshot = await loadAuthoritativeExecutionReview(runtime, grant.event);
  const { inputs, review } = await loadCurrentAuthoritativeExecutionInputs(runtime, snapshot);
  const job = inputs.plan.find((job) => job.name === grant.event.jobName && job.kind === grant.event.executionKind);
  if (job === undefined || inputs.configBlob === null
    || grant.descriptor.expectedProtectedHead !== review.expectedProtectedHead
    || grant.descriptor.candidateCommit !== review.candidateCommit || grant.descriptor.candidateTree !== review.candidateTree
    || grant.descriptor.policyRevision !== review.policyRevision
    || grant.descriptor.requiredReviewRevision !== review.requiredReviewRevision
    || grant.descriptor.requiredJobSetRevision !== snapshot.envelope.qualityRevision
    || !isDeepStrictEqual(grant.descriptor.configBlob, inputs.configBlob)
    || !isDeepStrictEqual(grant.descriptor.script, job.script) || !isDeepStrictEqual(grant.descriptor.argv, job.argv)) {
    throw new ExecutionConflictError("execution descriptor no longer matches reviewed inputs");
  }
  if (!snapshot.envelope.events.some((event) => isDeepStrictEqual(event, grant.event))) throw new ExecutionConflictError("execution envelope is stale");
  const latest = (await grants(snapshot.target.repository)).filter((other) => sameJob(other, grant.event))
    .sort((left, right) => right.attempt - left.attempt)[0];
  if (latest?.executionId !== grant.executionId) throw new ExecutionConflictError("execution attempt was superseded");
  return snapshot.target.repository;
}

export async function recordExecutionEvidence(runtime: AuthoritativeNativeCandidateRuntime,
  grant: ExecutionGrant, value: unknown): Promise<ExecutionResult> {
  const result = executionResultSchema.parse(value);
  if (result.executionId !== grant.executionId || result.descriptorDigest !== grant.descriptorDigest) {
    throw new ExecutionConflictError("execution result does not match its grant");
  }
  const repository = await assertCurrentExecution(runtime, grant);
  const root = join(repository, "dim-execution-evidence");
  await ownedReviewDirectory(root);
  const path = join(root, `${grant.executionId}.json`);
  const existing = await readOptional(path);
  if (existing !== undefined) {
    const previous = executionResultSchema.parse(existing);
    if (!isDeepStrictEqual(previous, result)) throw new ExecutionConflictError("execution already has another result");
    return previous;
  }
  await writeImmutableReviewRecord(path, result);
  return result;
}

export async function currentExecutionEvidence(runtime: AuthoritativeNativeCandidateRuntime,
  repository: string, event: ExecutionGrant["event"]): Promise<{ grant: ExecutionGrant; result: ExecutionResult; digest: string }> {
  const grant = (await grants(repository)).filter((grant) => sameJob(grant, event)).sort((a, b) => b.attempt - a.attempt)[0];
  if (grant === undefined) throw new ExecutionConflictError("execution evidence is missing");
  await assertCurrentExecution(runtime, grant);
  const value = await readOptional(join(repository, "dim-execution-evidence", `${grant.executionId}.json`));
  if (value === undefined) throw new ExecutionConflictError("execution evidence is missing");
  const result = executionResultSchema.parse(value);
  return { grant, result, digest: createHash("sha256").update(JSON.stringify({ grant, result })).digest("hex") };
}

async function grants(repository: string): Promise<ExecutionGrant[]> {
  const root = join(repository, "dim-execution-grants");
  let names: string[];
  try { names = await readdir(root); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
  if (names.some((name) => !/^[0-9a-f-]{36}\.json$/.test(name))) throw new ExecutionConflictError("execution grant storage is invalid");
  return Promise.all(names.sort().map(async (name) => executionGrantSchema.parse(await readOptional(join(root, name)))));
}
function sameJob(grant: ExecutionGrant, event: ExecutionGrant["event"]): boolean {
  return grant.event.projectId === event.projectId && grant.event.envelopeId === event.envelopeId
    && grant.event.executionKind === event.executionKind && grant.event.jobName === event.jobName;
}
export class ExecutionConflictError extends Error {}

async function readOptional(path: string): Promise<unknown> {
  try { return await readStoredJson(path, 512 * 1024); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
