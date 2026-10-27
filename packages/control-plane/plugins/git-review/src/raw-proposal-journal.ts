import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import {
  publishReviewRecord,
  readReviewJson,
  replaceReviewRecord
} from "./review-record-storage.js";
import {
  initializeRawProposalJournal,
  maximumRawProposalJobBytes,
  maximumRawProposalJobs,
  RawProposalJournalError,
  readRawProposalRecordNames,
  withRawProposalJournalOperation
} from "./raw-proposal-journal-storage.js";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const authoritySchema = z.object({
  ownerHostId: z.string().min(1).max(128),
  importGenerationId: digest,
  importNonce: z.string().uuid(),
  bundleDigest: digest,
  resolvedTree: objectId,
  headSequence: z.number().int().nonnegative(),
  headTree: objectId
}).strict().readonly();
export const rawProposalBindingSchema = z.object({
  schemaVersion: z.literal(1), generationId: digest, projectId: identifier, repositoryId: identifier,
  proposalRef: z.string().startsWith("refs/heads/proposals/"), protectedRef: z.string().startsWith("refs/heads/"),
  expectedProtectedHead: objectId, candidateCommit: objectId, candidateTree: objectId,
  policyDigest: digest, authority: authoritySchema
}).strict().readonly();
const stateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict().readonly(),
  z.object({ status: z.literal("failed"), failure: z.literal("review-preparation-failed") }).strict().readonly(),
  z.object({ status: z.literal("stale"), staleReason: z.enum([
    "authority-changed", "candidate-ref-changed", "generation-changed", "policy-changed", "protected-head-changed"
  ]) }).strict().readonly(),
  z.object({ status: z.literal("ready"), reviewId: digest, envelopeId: digest }).strict().readonly()
]);
const recordSchema = z.object({
  jobId: digest, capturedAt: z.string().datetime(), binding: rawProposalBindingSchema, state: stateSchema
}).strict().readonly();

export type RawProposalBinding = z.infer<typeof rawProposalBindingSchema>;
export type RawProposalJob = z.infer<typeof recordSchema>;
export type RawProposalState = z.infer<typeof stateSchema>;
const updates = new Map<string, Promise<void>>();

export async function stageRawProposalJob(repository: string, input: RawProposalBinding): Promise<RawProposalJob> {
  const binding = rawProposalBindingSchema.parse(input);
  const jobId = rawProposalJobId(binding);
  const record = recordSchema.parse({ jobId, capturedAt: new Date().toISOString(), binding, state: { status: "pending" } });
  return withRawProposalJournalOperation(repository, async () => {
    const paths = await initialize(repository);
    const path = join(paths.records, `${jobId}.json`);
    const previous = await readRawProposalJobIfPresent(path);
    if (previous !== undefined) return assertMatchingJob(previous, jobId, binding);
    const names = await readRawProposalRecordNames(paths);
    if (names.length >= maximumRawProposalJobs) {
      throw new RawProposalJournalError("raw proposal job capacity exceeded");
    }
    try {
      await publishReviewRecord({ path, serialized: serialize(record), stagingRoot: paths.staging, faults: {} });
      return record;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      return assertMatchingJob(await readRawProposalJob(path), jobId, binding);
    }
  });
}

export async function replaceRawProposalJob(
  repository: string,
  job: RawProposalJob,
  state: RawProposalState
): Promise<RawProposalJob> {
  const path = join(repository, "dim-raw-proposal-jobs", "records", `${job.jobId}.json`);
  return withRecordUpdate(path, async () => {
    return withRawProposalJournalOperation(repository, async () => {
      const paths = await initialize(repository);
      const current = await readRawProposalJob(path);
      if (JSON.stringify(current.binding) !== JSON.stringify(job.binding)) {
        throw new RawProposalJournalError("raw proposal job changed during processing");
      }
      if (current.state.status === "ready" || current.state.status === "stale") return current;
      const updated = recordSchema.parse({ ...current, state });
      await replaceReviewRecord({ path, serialized: serialize(updated), stagingRoot: paths.staging, faults: {} });
      return updated;
    });
  });
}

export async function readRawProposalJobs(repository: string, generationId?: string): Promise<readonly RawProposalJob[]> {
  const paths = await withRawProposalJournalOperation(repository, () => initialize(repository));
  const names = await readRawProposalRecordNames(paths);
  if (names.length > maximumRawProposalJobs) throw new RawProposalJournalError("raw proposal job capacity exceeded");
  const jobs: RawProposalJob[] = [];
  for (const name of names) {
    const job = await readRawProposalJob(join(paths.records, name));
    if (name !== `${job.jobId}.json` || job.jobId !== rawProposalJobId(job.binding)) {
      throw new RawProposalJournalError("raw proposal job identity is invalid");
    }
    if (generationId === undefined || job.binding.generationId === generationId) jobs.push(job);
  }
  return jobs.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.jobId.localeCompare(right.jobId));
}

export async function completeMatchingRawProposalJob(
  repository: string,
  generationId: string,
  envelope: AuthoritativeNativeReviewEnvelope
): Promise<void> {
  for (const job of await readRawProposalJobs(repository, generationId)) {
    const binding = job.binding;
    const review = envelope.review;
    if (binding.projectId !== review.projectId || binding.repositoryId !== review.repositoryId
      || binding.proposalRef !== review.proposalRef || binding.protectedRef !== review.protectedRef
      || binding.expectedProtectedHead !== review.expectedProtectedHead || binding.candidateCommit !== review.candidateCommit
      || binding.candidateTree !== review.candidateTree || binding.policyDigest !== envelope.policyDigest
      || (job.state.status !== "pending" && job.state.status !== "failed")) continue;
    await replaceRawProposalJob(repository, job, { status: "ready", reviewId: review.reviewId, envelopeId: envelope.envelopeId });
  }
}

export function rawProposalJobId(binding: RawProposalBinding): string {
  return createHash("sha256").update("dim-raw-proposal-job-v1\0").update(JSON.stringify(rawProposalBindingSchema.parse(binding))).digest("hex");
}

async function readRawProposalJob(path: string): Promise<RawProposalJob> {
  return recordSchema.parse(await readReviewJson(path, maximumRawProposalJobBytes));
}

async function readRawProposalJobIfPresent(path: string): Promise<RawProposalJob | undefined> {
  try {
    return await readRawProposalJob(path);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function assertMatchingJob(previous: RawProposalJob, jobId: string, binding: RawProposalBinding): RawProposalJob {
  if (previous.jobId !== jobId || JSON.stringify(previous.binding) !== JSON.stringify(binding)) {
    throw new RawProposalJournalError("raw proposal job identity conflicts");
  }
  return previous;
}

async function withRecordUpdate<Result>(path: string, operation: () => Promise<Result>): Promise<Result> {
  const previous = updates.get(path) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
  updates.set(path, current);
  await previous;
  try { return await operation(); }
  finally {
    release?.();
    if (updates.get(path) === current) updates.delete(path);
  }
}

function serialize(record: RawProposalJob): string {
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized) > maximumRawProposalJobBytes) {
    throw new RawProposalJournalError("raw proposal job exceeds its storage bound");
  }
  return serialized;
}

async function initialize(repository: string) {
  return initializeRawProposalJournal(repository, (value) => recordSchema.parse(value), rawProposalJobId);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export { RawProposalJournalError };
