import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  jobAttemptRevocationSchema,
  jobAttemptSchema,
  type JobAttempt,
  type JobAttemptRevocation
} from "./job-attempt-schema.js";

const reviewIdPattern = /^[0-9a-f]{64}$/;
const jobNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const attemptPattern = /^[1-9][0-9]*\.json$/;
const MAX_RECORD_BYTES = 64 * 1024;

type IssueInput = {
  readonly reviewId: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly jobName: string;
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
  issue(input: IssueInput): Promise<JobAttempt>;
  current(reviewId: string, jobName: string): Promise<CurrentJobAttempt | undefined>;
  revoke(input: RevokeInput): Promise<JobAttemptRevocation>;
};

export async function initializeJobAttemptStore(repositoryPath: string): Promise<void> {
  await Promise.all([
    ownedDirectory(join(repositoryPath, "dim-reviews", "job-attempts")),
    ownedDirectory(join(repositoryPath, "dim-reviews", "job-attempt-revocations"))
  ]);
}

export async function assertJobAttemptStore(repositoryPath: string): Promise<void> {
  const attempts = join(repositoryPath, "dim-reviews", "job-attempts");
  const revocations = join(repositoryPath, "dim-reviews", "job-attempt-revocations");
  await assertTree(attempts, jobAttemptSchema.parse);
  await assertTree(revocations, jobAttemptRevocationSchema.parse);
}

export function createJobAttemptStore(repositoryPath: string): JobAttemptStore {
  const attempts = join(repositoryPath, "dim-reviews", "job-attempts");
  const revocations = join(repositoryPath, "dim-reviews", "job-attempt-revocations");
  return {
    async issue(input) {
      const current = await readLatest(attempts, input.reviewId, input.jobName, jobAttemptSchema.parse);
      const attempt = (current?.attempt ?? 0) + 1;
      const issuance = jobAttemptSchema.parse({
        schemaVersion: 1,
        attemptId: randomUUID(),
        ...input,
        attempt,
        issuedAt: new Date().toISOString()
      });
      const path = recordPath(attempts, input.reviewId, input.jobName, attempt);
      await ownedDirectory(dirname(path));
      await writeImmutable(path, issuance);
      return issuance;
    },
    async current(reviewId, jobName) {
      const issuance = await readLatest(attempts, reviewId, jobName, jobAttemptSchema.parse);
      if (issuance === undefined) return undefined;
      const revocation = await readRecord(
        recordPath(revocations, reviewId, jobName, issuance.attempt),
        jobAttemptRevocationSchema.parse
      );
      return { issuance, revocation };
    },
    async revoke(input) {
      const current = await this.current(input.reviewId, input.jobName);
      if (current === undefined || current.issuance.attemptId !== input.attemptId) {
        throw new JobAttemptStoreError("current job attempt was not found");
      }
      if (current.revocation !== undefined) return current.revocation;
      const revocation = jobAttemptRevocationSchema.parse({
        schemaVersion: 1,
        revocationId: randomUUID(),
        attemptId: input.attemptId,
        reviewId: input.reviewId,
        jobName: input.jobName,
        attempt: current.issuance.attempt,
        revokedBy: input.revokedBy,
        revokedAt: new Date().toISOString()
      });
      const path = recordPath(revocations, input.reviewId, input.jobName, current.issuance.attempt);
      await ownedDirectory(dirname(path));
      await writeImmutable(path, revocation);
      return revocation;
    }
  };
}

async function assertTree<T extends { readonly reviewId: string; readonly jobName: string; readonly attempt: number }>(
  root: string,
  parse: (input: unknown) => T
): Promise<void> {
  await assertOwnedDirectory(root);
  for (const review of await readdir(root, { withFileTypes: true })) {
    if (!review.isDirectory() || !reviewIdPattern.test(review.name)) throw new JobAttemptStoreError("job attempt store contains an invalid review entry");
    const reviewRoot = join(root, review.name);
    await assertOwnedDirectory(reviewRoot);
    for (const job of await readdir(reviewRoot, { withFileTypes: true })) {
      if (!job.isDirectory() || !jobNamePattern.test(job.name)) throw new JobAttemptStoreError("job attempt store contains an invalid job entry");
      const jobRoot = join(reviewRoot, job.name);
      await assertOwnedDirectory(jobRoot);
      for (const attempt of await readdir(jobRoot, { withFileTypes: true })) {
        if (!attempt.isFile() || !attemptPattern.test(attempt.name)) throw new JobAttemptStoreError("job attempt store contains an invalid attempt entry");
        const record = parse(await readJson(join(jobRoot, attempt.name)));
        if (record.reviewId !== review.name || record.jobName !== job.name || `${record.attempt}.json` !== attempt.name) {
          throw new JobAttemptStoreError("job attempt path does not match its identity");
        }
      }
    }
  }
}

async function readLatest<T extends { readonly attempt: number }>(
  root: string,
  reviewId: string,
  jobName: string,
  parse: (input: unknown) => T
): Promise<T | undefined> {
  const directory = join(root, reviewId, jobName);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const attempts = entries.filter((entry) => entry.isFile() && attemptPattern.test(entry.name))
    .map((entry) => Number.parseInt(entry.name, 10));
  if (attempts.length === 0) return undefined;
  return readRecord(recordPath(root, reviewId, jobName, Math.max(...attempts)), parse);
}

async function readRecord<T>(path: string, parse: (input: unknown) => T): Promise<T | undefined> {
  try {
    return parse(await readJson(path));
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function recordPath(root: string, reviewId: string, jobName: string, attempt: number): string {
  return join(root, reviewId, jobName, `${attempt}.json`);
}

async function writeImmutable(path: string, value: unknown): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== serviceUid() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_RECORD_BYTES) {
      throw new JobAttemptStoreError("job attempt record must be a bounded caller-owned mode-0600 regular file");
    }
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}

async function ownedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertOwnedDirectory(path);
  await chmod(path, 0o700);
}

async function assertOwnedDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== serviceUid()) {
    throw new JobAttemptStoreError("job attempt store must contain caller-owned directories");
  }
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new JobAttemptStoreError("native Git job attempts require a Linux user identity");
  return uid;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class JobAttemptStoreError extends Error {
  readonly name = "JobAttemptStoreError";
}
