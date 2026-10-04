import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const reviewIdPattern = /^[0-9a-f]{64}$/;
const jobNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const attemptFilePattern = /^[1-9][0-9]*\.json$/;
const MAX_RECORD_BYTES = 64 * 1024;

export type JobAttemptLocation = {
  readonly reviewId: string;
  readonly jobName: string;
  readonly attempt: number;
};

export async function assertJobAttemptTree<
  T extends { readonly reviewId: string; readonly jobName: string; readonly attempt: number }
>(root: string, parse: (input: unknown) => T): Promise<void> {
  await assertOwnedDirectory(root);
  for (const review of await readdir(root, { withFileTypes: true })) {
    if (!review.isDirectory() || !reviewIdPattern.test(review.name)) {
      throw new JobAttemptStoreError("job attempt store contains an invalid review entry");
    }
    const reviewRoot = join(root, review.name);
    await assertOwnedDirectory(reviewRoot);
    for (const job of await readdir(reviewRoot, { withFileTypes: true })) {
      if (!job.isDirectory() || !jobNamePattern.test(job.name)) {
        throw new JobAttemptStoreError("job attempt store contains an invalid job entry");
      }
      const jobRoot = join(reviewRoot, job.name);
      await assertOwnedDirectory(jobRoot);
      for (const attempt of await readdir(jobRoot, { withFileTypes: true })) {
        if (!attempt.isFile() || !attemptFilePattern.test(attempt.name)) {
          throw new JobAttemptStoreError("job attempt store contains an invalid attempt entry");
        }
        const record = parse(await readJobAttemptJson(join(jobRoot, attempt.name)));
        if (record.reviewId !== review.name || record.jobName !== job.name
          || `${record.attempt}.json` !== attempt.name) {
          throw new JobAttemptStoreError("job attempt path does not match its identity");
        }
      }
    }
  }
}

export async function readLatestJobAttempt<T extends { readonly attempt: number }>(
  root: string,
  identity: Omit<JobAttemptLocation, "attempt">,
  parse: (input: unknown) => T
): Promise<T | undefined> {
  const directory = join(root, identity.reviewId, identity.jobName);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isFileCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const attempts = entries.filter((entry) => entry.isFile() && attemptFilePattern.test(entry.name))
    .map((entry) => Number.parseInt(entry.name, 10));
  if (attempts.length === 0) return undefined;
  return readJobAttemptRecord(jobAttemptRecordPath(root, { ...identity, attempt: Math.max(...attempts) }), parse);
}

export async function readJobAttemptRecord<T>(
  path: string,
  parse: (input: unknown) => T
): Promise<T | undefined> {
  try {
    return parse(await readJobAttemptJson(path));
  } catch (error) {
    if (isFileCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export function jobAttemptRecordPath(root: string, location: JobAttemptLocation): string {
  return join(root, location.reviewId, location.jobName, `${location.attempt}.json`);
}

export async function writeImmutableJobAttempt(path: string, value: unknown): Promise<void> {
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

export async function readJobAttemptJson(path: string): Promise<unknown> {
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

export async function ensureJobAttemptDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertOwnedDirectory(path);
  await chmod(path, 0o700);
}

export function isFileCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
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

export class JobAttemptStoreError extends Error {
  readonly name = "JobAttemptStoreError";
}
