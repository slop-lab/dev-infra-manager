import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RawProposalBinding, RawProposalJob } from "./raw-proposal-journal.js";
import { ownedReviewDirectory } from "./review-record-storage.js";

export const maximumRawProposalJobBytes = 16 * 1024;
export const maximumRawProposalJobs = 100_000;

export type RawProposalJournalPaths = {
  readonly records: string;
  readonly staging: string;
};

type ParseRecord = (value: unknown) => RawProposalJob;
type RecordId = (binding: RawProposalBinding) => string;

const operations = new Map<string, Promise<void>>();
const recordPattern = /^[0-9a-f]{64}\.json$/;
const stagingPattern = /^([0-9a-f]{64}\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

export async function withRawProposalJournalOperation<Result>(
  repository: string,
  operation: () => Promise<Result>
): Promise<Result> {
  const previous = operations.get(repository) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
  operations.set(repository, current);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (operations.get(repository) === current) operations.delete(repository);
  }
}

export async function initializeRawProposalJournal(
  repository: string,
  parseRecord: ParseRecord,
  recordId: RecordId
): Promise<RawProposalJournalPaths> {
  const root = join(repository, "dim-raw-proposal-jobs");
  const paths = { records: join(root, "records"), staging: join(root, "staging") };
  await ensurePrivateDirectory(root);
  await syncDirectory(repository);
  await ensurePrivateDirectory(paths.records);
  await ensurePrivateDirectory(paths.staging);
  await syncDirectory(root);
  await assertLayout(root, paths);
  await recoverRawProposalStaging(paths, parseRecord, recordId);
  return paths;
}

export async function readRawProposalRecordNames(paths: RawProposalJournalPaths): Promise<readonly string[]> {
  const entries = (await readdir(paths.records, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !recordPattern.test(entry.name)) {
      throw new RawProposalJournalError("raw proposal job path is invalid");
    }
    names.push(entry.name);
  }
  return names;
}

async function recoverRawProposalStaging(
  paths: RawProposalJournalPaths,
  parseRecord: ParseRecord,
  recordId: RecordId
): Promise<void> {
  const entries = (await readdir(paths.staging, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const match = stagingPattern.exec(entry.name);
    if (!entry.isFile() || match === null || match[1] === undefined) {
      throw new RawProposalJournalError("raw proposal staging entry is invalid");
    }
    const stagedPath = join(paths.staging, entry.name);
    const finalPath = join(paths.records, match[1]);
    const staged = await readPrivateJob(stagedPath, parseRecord);
    assertRecordIdentity(match[1], staged.job, recordId);
    if (staged.stat.nlink === 2) {
      const final = await readPrivateJob(finalPath, parseRecord);
      assertRecordIdentity(match[1], final.job, recordId);
      if (final.stat.nlink !== 2 || final.stat.dev !== staged.stat.dev || final.stat.ino !== staged.stat.ino) {
        throw new RawProposalJournalError("raw proposal staging entry does not match its published job");
      }
    } else if (staged.stat.nlink === 1) {
      const final = await readPrivateJobIfPresent(finalPath, parseRecord);
      if (final !== undefined) {
        assertRecordIdentity(match[1], final.job, recordId);
        if (final.stat.nlink !== 1 || (final.stat.dev === staged.stat.dev && final.stat.ino === staged.stat.ino)
          || JSON.stringify(final.job.binding) !== JSON.stringify(staged.job.binding)) {
          throw new RawProposalJournalError("raw proposal replacement staging identity is invalid");
        }
      }
    } else {
      throw new RawProposalJournalError("raw proposal staging link count is invalid");
    }
    await unlink(stagedPath);
    await syncDirectory(paths.staging);
  }
}

async function readPrivateJob(
  path: string,
  parseRecord: ParseRecord
): Promise<{ readonly job: RawProposalJob; readonly stat: Stats }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    assertPrivateFile(stat);
    if (stat.size > maximumRawProposalJobBytes) {
      throw new RawProposalJournalError("raw proposal job exceeds its storage bound");
    }
    const serialized = await file.readFile("utf8");
    const value: unknown = JSON.parse(serialized);
    return { job: parseRecord(value), stat };
  } finally {
    await file.close();
  }
}

async function readPrivateJobIfPresent(
  path: string,
  parseRecord: ParseRecord
): Promise<{ readonly job: RawProposalJob; readonly stat: Stats } | undefined> {
  try {
    return await readPrivateJob(path, parseRecord);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function assertRecordIdentity(name: string, job: RawProposalJob, recordId: RecordId): void {
  if (name !== `${job.jobId}.json` || job.jobId !== recordId(job.binding)) {
    throw new RawProposalJournalError("raw proposal job identity is invalid");
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await assertPrivateDirectory(path);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
    await ownedReviewDirectory(path);
    await assertPrivateDirectory(path);
  }
}

async function assertLayout(root: string, paths: RawProposalJournalPaths): Promise<void> {
  await assertPrivateDirectory(root);
  await assertPrivateDirectory(paths.records);
  await assertPrivateDirectory(paths.staging);
  const entries = await readdir(root, { withFileTypes: true });
  const allowed = new Set([basename(paths.records), basename(paths.staging)]);
  if (entries.length !== allowed.size || entries.some((entry) => !entry.isDirectory() || !allowed.has(entry.name))) {
    throw new RawProposalJournalError("raw proposal journal layout is invalid");
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== serviceUid() || (stat.mode & 0o777) !== 0o700) {
    throw new RawProposalJournalError("raw proposal journal directory is not private");
  }
}

function assertPrivateFile(stat: Stats): void {
  if (!stat.isFile() || stat.uid !== serviceUid() || (stat.mode & 0o777) !== 0o600) {
    throw new RawProposalJournalError("raw proposal journal file is not private");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new RawProposalJournalError("raw proposal journal requires a Linux user identity");
  return uid;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class RawProposalJournalError extends Error {
  readonly name = "RawProposalJournalError";
}
