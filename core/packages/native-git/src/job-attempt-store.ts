import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  jobAttemptRevocationSchema,
  jobAttemptSchema,
  type JobAttempt,
  type JobAttemptRevocation
} from "./job-attempt-schema.js";
import type { CandidateOrdinaryExecutionDescriptor } from "./candidate-execution-schema.js";
import {
  assertJobAttemptTree,
  attemptFilePattern,
  ensureJobAttemptDirectory,
  isFileCode,
  jobAttemptRecordPath,
  JobAttemptStoreError,
  readJobAttemptJson,
  readJobAttemptRecord,
  readLatestJobAttempt,
  writeImmutableJobAttempt
} from "./job-attempt-storage.js";

export { JobAttemptStoreError } from "./job-attempt-storage.js";

type IssueInput = {
  readonly issuanceRequestId: string;
  readonly reviewId: string;
  readonly descriptor: CandidateOrdinaryExecutionDescriptor;
  readonly descriptorDigest: string;
  readonly hostId: string;
  readonly capacity: string;
  readonly issuedBy: string;
};

type RevokeInput = {
  readonly reviewId: string;
  readonly jobName: string;
  readonly attemptId: string;
  readonly revokedBy: string;
};

export type CurrentJobAttempt = {
  readonly issuance: JobAttempt;
  readonly revocation: JobAttemptRevocation | undefined;
};

export type JobAttemptStore = {
  issue(input: IssueInput): Promise<{ readonly issuance: JobAttempt; readonly replayed: boolean }>;
  current(reviewId: string, jobName: string): Promise<CurrentJobAttempt | undefined>;
  revoke(input: RevokeInput): Promise<JobAttemptRevocation>;
};

export async function initializeJobAttemptStore(repositoryPath: string): Promise<void> {
  await Promise.all([
    ensureJobAttemptDirectory(join(repositoryPath, "dim-reviews", "job-attempts")),
    ensureJobAttemptDirectory(join(repositoryPath, "dim-reviews", "job-attempt-revocations"))
  ]);
}

export async function assertJobAttemptStore(repositoryPath: string): Promise<void> {
  const attempts = join(repositoryPath, "dim-reviews", "job-attempts");
  const revocations = join(repositoryPath, "dim-reviews", "job-attempt-revocations");
  await assertJobAttemptTree(attempts, (input) => {
    const record = jobAttemptSchema.parse(input);
    return { reviewId: record.reviewId, jobName: record.descriptor.jobName, attempt: record.attempt };
  });
  await assertJobAttemptTree(revocations, jobAttemptRevocationSchema.parse);
  for (const review of await readdir(revocations, { withFileTypes: true })) {
    for (const job of await readdir(join(revocations, review.name), { withFileTypes: true })) {
      for (const entry of await readdir(join(revocations, review.name, job.name), { withFileTypes: true })) {
        const revocation = jobAttemptRevocationSchema.parse(
          await readJobAttemptJson(join(revocations, review.name, job.name, entry.name))
        );
        const issuance = await readJobAttemptRecord(
          jobAttemptRecordPath(attempts, revocation),
          jobAttemptSchema.parse
        );
        if (issuance === undefined || !revocationMatchesIssuance(revocation, issuance)) {
          throw new JobAttemptStoreError("job attempt revocation does not match its issuance");
        }
      }
    }
  }
}

export function createJobAttemptStore(repositoryPath: string): JobAttemptStore {
  const attempts = join(repositoryPath, "dim-reviews", "job-attempts");
  const revocations = join(repositoryPath, "dim-reviews", "job-attempt-revocations");
  return {
    async issue(input) {
      const jobName = input.descriptor.jobName;
      const prior = await findIssuanceRequest(attempts, input.reviewId, input.issuanceRequestId);
      const current = await readLatestJobAttempt(attempts, { reviewId: input.reviewId, jobName }, jobAttemptSchema.parse);
      if (prior !== undefined) {
        const revocation = await readJobAttemptRecord(
          jobAttemptRecordPath(revocations, {
            reviewId: prior.reviewId,
            jobName: prior.descriptor.jobName,
            attempt: prior.attempt
          }),
          jobAttemptRevocationSchema.parse
        );
        if (current?.attemptId === prior.attemptId && revocation === undefined && issuanceMatchesInput(prior, input)) {
          return { issuance: prior, replayed: true };
        }
        throw new JobAttemptStoreError("issuance request ID was already used");
      }
      const attempt = (current?.attempt ?? 0) + 1;
      const issuance = jobAttemptSchema.parse({
        schemaVersion: 2,
        attemptId: randomUUID(),
        ...input,
        attempt,
        issuedAt: new Date().toISOString()
      });
      const path = jobAttemptRecordPath(attempts, { reviewId: input.reviewId, jobName, attempt });
      await ensureJobAttemptDirectory(dirname(path));
      await writeImmutableJobAttempt(path, issuance);
      return { issuance, replayed: false };
    },
    async current(reviewId, jobName) {
      const issuance = await readLatestJobAttempt(attempts, { reviewId, jobName }, jobAttemptSchema.parse);
      if (issuance === undefined) return undefined;
      const revocation = await readJobAttemptRecord(
        jobAttemptRecordPath(revocations, { reviewId, jobName, attempt: issuance.attempt }),
        jobAttemptRevocationSchema.parse
      );
      if (revocation !== undefined && !revocationMatchesIssuance(revocation, issuance)) {
        throw new JobAttemptStoreError("job attempt revocation does not match its issuance");
      }
      return { issuance, revocation };
    },
    async revoke(input) {
      const current = await this.current(input.reviewId, input.jobName);
      if (current === undefined || current.issuance.attemptId !== input.attemptId) {
        throw new JobAttemptStoreError("current job attempt was not found");
      }
      if (current.revocation !== undefined) return current.revocation;
      const revocation = jobAttemptRevocationSchema.parse({
        schemaVersion: 2,
        revocationId: randomUUID(),
        attemptId: input.attemptId,
        reviewId: input.reviewId,
        jobName: input.jobName,
        attempt: current.issuance.attempt,
        descriptorDigest: current.issuance.descriptorDigest,
        hostId: current.issuance.hostId,
        capacity: current.issuance.capacity,
        revokedBy: input.revokedBy,
        revokedAt: new Date().toISOString()
      });
      const path = jobAttemptRecordPath(revocations, {
        reviewId: input.reviewId,
        jobName: input.jobName,
        attempt: current.issuance.attempt
      });
      await ensureJobAttemptDirectory(dirname(path));
      await writeImmutableJobAttempt(path, revocation);
      return revocation;
    }
  };
}

async function findIssuanceRequest(
  root: string,
  reviewId: string,
  issuanceRequestId: string
): Promise<JobAttempt | undefined> {
  const reviewRoot = join(root, reviewId);
  let jobs;
  try {
    jobs = await readdir(reviewRoot, { withFileTypes: true });
  } catch (error) {
    if (isFileCode(error, "ENOENT")) return undefined;
    throw error;
  }
  for (const job of jobs) {
    if (!job.isDirectory()) continue;
    const directory = join(reviewRoot, job.name);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !attemptFilePattern.test(entry.name)) continue;
      const attempt = jobAttemptSchema.parse(await readJobAttemptJson(join(directory, entry.name)));
      if (attempt.issuanceRequestId === issuanceRequestId) return attempt;
    }
  }
  return undefined;
}

function issuanceMatchesInput(issuance: JobAttempt, input: IssueInput): boolean {
  return issuance.reviewId === input.reviewId
    && issuance.descriptorDigest === input.descriptorDigest
    && JSON.stringify(issuance.descriptor) === JSON.stringify(input.descriptor)
    && issuance.hostId === input.hostId
    && issuance.capacity === input.capacity
    && issuance.issuedBy === input.issuedBy;
}

function revocationMatchesIssuance(revocation: JobAttemptRevocation, issuance: JobAttempt): boolean {
  return revocation.attemptId === issuance.attemptId
    && revocation.reviewId === issuance.reviewId
    && revocation.jobName === issuance.descriptor.jobName
    && revocation.attempt === issuance.attempt
    && revocation.descriptorDigest === issuance.descriptorDigest
    && revocation.hostId === issuance.hostId
    && revocation.capacity === issuance.capacity;
}
