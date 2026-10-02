import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseCiStatusRecord, type CiStatusRecord } from "./promotion-schema.js";

const reviewIdPattern = /^[0-9a-f]{64}$/;
const jobNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const attemptPattern = /^[1-9][0-9]*\.json$/;
const MAX_RECORD_BYTES = 64 * 1024;

export type StatusStore = {
  saveStatus(status: CiStatusRecord): Promise<CiStatusRecord>;
  readStatuses(reviewId: string): Promise<readonly CiStatusRecord[]>;
};

export async function initializeStatusStore(repositoryPath: string): Promise<void> {
  await ownedDirectory(join(repositoryPath, "dim-reviews", "statuses"));
}

export async function assertStatusStore(repositoryPath: string): Promise<void> {
  const root = join(repositoryPath, "dim-reviews", "statuses");
  await assertOwnedDirectory(root);
  for (const reviewEntry of await readdir(root, { withFileTypes: true })) {
    if (!reviewEntry.isDirectory() || !reviewIdPattern.test(reviewEntry.name)) {
      throw new StatusStoreError("CI status store contains an invalid review entry");
    }
    const reviewRoot = join(root, reviewEntry.name);
    await assertOwnedDirectory(reviewRoot);
    for (const jobEntry of await readdir(reviewRoot, { withFileTypes: true })) {
      if (!jobEntry.isDirectory() || !jobNamePattern.test(jobEntry.name)) {
        throw new StatusStoreError("CI status store contains an invalid job entry");
      }
      const jobRoot = join(reviewRoot, jobEntry.name);
      await assertOwnedDirectory(jobRoot);
      for (const attemptEntry of await readdir(jobRoot, { withFileTypes: true })) {
        if (!attemptEntry.isFile() || !attemptPattern.test(attemptEntry.name)) {
          throw new StatusStoreError("CI status store contains an invalid attempt entry");
        }
        const status = parseCiStatusRecord(await readJson(join(jobRoot, attemptEntry.name)));
        if (status.reviewId !== reviewEntry.name || status.payload.jobName !== jobEntry.name
          || `${status.payload.attempt}.json` !== attemptEntry.name) {
          throw new StatusStoreError("CI status path does not match its identity");
        }
      }
    }
  }
}

export function createStatusStore(repositoryPath: string): StatusStore {
  const root = join(repositoryPath, "dim-reviews", "statuses");
  return {
    async saveStatus(status) {
      const directory = join(root, status.reviewId, status.payload.jobName);
      await ownedDirectory(directory);
      const path = join(directory, `${status.payload.attempt}.json`);
      try {
        await writeImmutable(path, status);
        return status;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        const existing = parseCiStatusRecord(await readJson(path));
        if (existing.statusId !== status.statusId) throw new StatusConflictError("CI job attempt already has a different result");
        return existing;
      }
    },
    async readStatuses(reviewId) {
      const reviewRoot = join(root, reviewId);
      let jobs;
      try {
        jobs = await readdir(reviewRoot, { withFileTypes: true });
      } catch (error) {
        if (isCode(error, "ENOENT")) return [];
        throw error;
      }
      const statuses: CiStatusRecord[] = [];
      for (const job of jobs.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!job.isDirectory() || !jobNamePattern.test(job.name)) throw new StatusStoreError("CI status job entry is invalid");
        const jobRoot = join(reviewRoot, job.name);
        for (const attempt of (await readdir(jobRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
          if (!attempt.isFile() || !attemptPattern.test(attempt.name)) throw new StatusStoreError("CI status attempt entry is invalid");
          statuses.push(parseCiStatusRecord(await readJson(join(jobRoot, attempt.name))));
        }
      }
      return statuses;
    }
  };
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
      throw new StatusStoreError("CI status record must be a bounded caller-owned mode-0600 regular file");
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
    throw new StatusStoreError("CI status store must contain caller-owned directories");
  }
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new StatusStoreError("native Git CI evidence requires a Linux user identity");
  return uid;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class StatusStoreError extends Error {
  readonly name = "StatusStoreError";
}

export class StatusConflictError extends Error {
  readonly name = "StatusConflictError";
}
