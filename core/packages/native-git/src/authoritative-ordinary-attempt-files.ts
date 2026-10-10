import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  authoritativeOrdinaryAttemptRevocationSchema,
  authoritativeOrdinaryAttemptSchema,
  type AuthoritativeOrdinaryAttempt,
  type AuthoritativeOrdinaryAttemptRevocation
} from "./authoritative-ordinary-attempt-schema.js";
import {
  assertOwnedReviewDirectory,
  ownedReviewDirectory,
  readReviewJson
} from "./review-record-storage.js";

const maximumRecordBytes = 256 * 1024;
export const maximumOrdinaryAttemptsPerJob = 256;
const attemptFilePattern = /^([1-9][0-9]*)\.json$/;
const temporaryFilePattern = /^\.([1-9][0-9]*\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

export type OrdinaryAttemptStorePaths = {
  readonly root: string;
  readonly kind: string;
  readonly issuances: string;
  readonly revocations: string;
};

export function ordinaryAttemptStorePaths(repository: string): OrdinaryAttemptStorePaths {
  const root = join(repository, "dim-authoritative-attempts");
  const kind = join(root, "ordinary-sysbox");
  return { root, kind, issuances: join(kind, "issuances"), revocations: join(kind, "revocations") };
}

export async function initializeOrdinaryAttemptStore(paths: OrdinaryAttemptStorePaths): Promise<void> {
  for (const path of [paths.root, paths.kind, paths.issuances, paths.revocations]) await ensurePrivateDirectory(path);
}

export async function assertOrdinaryAttemptStoreLayout(paths: OrdinaryAttemptStorePaths): Promise<void> {
  if (!(await pathExists(paths.root))) return;
  await assertPrivateDirectory(paths.root);
  const rootEntries = await readdir(paths.root, { withFileTypes: true });
  if (rootEntries.length !== 1 || rootEntries[0]?.name !== "ordinary-sysbox" || !rootEntries[0].isDirectory()) {
    throw new OrdinaryAttemptFilesError("ordinary attempt store layout is invalid");
  }
  await assertPrivateDirectory(paths.kind);
  const kindEntries = await readdir(paths.kind, { withFileTypes: true });
  if (kindEntries.length !== 2 || kindEntries.some((entry) => !entry.isDirectory()
    || (entry.name !== "issuances" && entry.name !== "revocations"))) {
    throw new OrdinaryAttemptFilesError("ordinary attempt kind layout is invalid");
  }
}

export function readOrdinaryAttempts(paths: OrdinaryAttemptStorePaths): Promise<readonly AuthoritativeOrdinaryAttempt[]> {
  return readRecords(paths.issuances, authoritativeOrdinaryAttemptSchema.parse, (record) => ({
    reviewId: record.reviewId, jobName: record.descriptor.jobName, attempt: record.attempt
  }), true);
}

export async function readOrdinaryAttemptsForJob(
  paths: OrdinaryAttemptStorePaths,
  reviewId: string,
  jobName: string
): Promise<readonly AuthoritativeOrdinaryAttempt[]> {
  const files = await selectedOrdinaryAttemptFiles(paths, reviewId, jobName);
  return Promise.all(files.map(({ path, attempt }) => readSelectedOrdinaryAttempt(path, reviewId, jobName, attempt)));
}

export function readOrdinaryRevocations(
  paths: OrdinaryAttemptStorePaths
): Promise<readonly AuthoritativeOrdinaryAttemptRevocation[]> {
  return readRecords(paths.revocations, authoritativeOrdinaryAttemptRevocationSchema.parse, (record) => ({
    reviewId: record.reviewId, jobName: record.jobName, attempt: record.attempt
  }), false);
}

export async function readCurrentOrdinaryAttempt(
  paths: OrdinaryAttemptStorePaths,
  reviewId: string,
  jobName: string
): Promise<{
  readonly attempt: AuthoritativeOrdinaryAttempt;
  readonly revocation: AuthoritativeOrdinaryAttemptRevocation | undefined;
} | undefined> {
  const selected = (await selectedOrdinaryAttemptFiles(paths, reviewId, jobName)).at(-1);
  if (selected === undefined) return undefined;
  const attempt = await readSelectedOrdinaryAttempt(selected.path, reviewId, jobName, selected.attempt);
  const attemptNumber = selected.attempt;
  const revocationPath = recordPath(paths.revocations, reviewId, jobName, attemptNumber);
  if (!(await pathExists(revocationPath))) return { attempt, revocation: undefined };
  await assertSelectedDirectory(paths.revocations, reviewId, jobName);
  const revocation = authoritativeOrdinaryAttemptRevocationSchema.parse(
    await readReviewJson(revocationPath, maximumRecordBytes, true));
  if (revocation.reviewId !== reviewId || revocation.jobName !== jobName || revocation.attempt !== attemptNumber) {
    throw new OrdinaryAttemptFilesError("attempt revocation conflicts with its path");
  }
  return { attempt, revocation };
}

async function selectedOrdinaryAttemptFiles(
  paths: OrdinaryAttemptStorePaths,
  reviewId: string,
  jobName: string
): Promise<readonly { readonly path: string; readonly attempt: number }[]> {
  if (!/^[0-9a-f]{64}$/.test(reviewId) || !/^[a-z][a-z0-9-]{0,62}$/.test(jobName)) {
    throw new OrdinaryAttemptFilesError("ordinary attempt selector is invalid");
  }
  if (!(await pathExists(paths.root))) return [];
  await assertOrdinaryAttemptStoreLayout(paths);
  await Promise.all([assertPrivateDirectory(paths.issuances), assertPrivateDirectory(paths.revocations)]);
  const directory = join(paths.issuances, reviewId, jobName);
  if (!(await pathExists(directory))) return [];
  await assertSelectedDirectory(paths.issuances, reviewId, jobName);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, "en", { numeric: true }));
  if (entries.length > maximumOrdinaryAttemptsPerJob) {
    throw new OrdinaryAttemptFilesError("ordinary attempt job exceeds its attempt bound");
  }
  return entries.map((entry, index) => {
    const attempt = index + 1;
    if (!entry.isFile() || entry.name !== `${attempt}.json`) {
      throw new OrdinaryAttemptFilesError("attempt record path is invalid");
    }
    return { path: join(directory, entry.name), attempt };
  });
}

async function readSelectedOrdinaryAttempt(
  path: string,
  reviewId: string,
  jobName: string,
  attemptNumber: number
): Promise<AuthoritativeOrdinaryAttempt> {
  const attempt = authoritativeOrdinaryAttemptSchema.parse(await readReviewJson(path, maximumRecordBytes, true));
  if (attempt.reviewId !== reviewId || attempt.descriptor.jobName !== jobName || attempt.attempt !== attemptNumber) {
    throw new OrdinaryAttemptFilesError("attempt record conflicts with its path");
  }
  return attempt;
}

export function writeOrdinaryAttempt(
  paths: OrdinaryAttemptStorePaths,
  attempt: AuthoritativeOrdinaryAttempt
): Promise<void> {
  return writeRecord(recordPath(paths.issuances, attempt.reviewId, attempt.descriptor.jobName, attempt.attempt), attempt);
}

export function writeOrdinaryRevocation(
  paths: OrdinaryAttemptStorePaths,
  revocation: AuthoritativeOrdinaryAttemptRevocation
): Promise<void> {
  return writeRecord(recordPath(paths.revocations, revocation.reviewId, revocation.jobName, revocation.attempt), revocation);
}

async function readRecords<RecordType>(
  root: string,
  parse: (value: unknown) => RecordType,
  identity: (record: RecordType) => { readonly reviewId: string; readonly jobName: string; readonly attempt: number },
  contiguous: boolean
): Promise<readonly RecordType[]> {
  if (!(await pathExists(root))) return [];
  const records: RecordType[] = [];
  for (const review of await directories(root)) {
    if (!/^[0-9a-f]{64}$/.test(review)) throw new OrdinaryAttemptFilesError("attempt review path is invalid");
    for (const job of await directories(join(root, review))) {
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(job)) throw new OrdinaryAttemptFilesError("attempt job path is invalid");
      const directory = join(root, review, job);
      await recoverTemporaryRecords(directory);
      let previousAttempt = 0;
      const entries = (await readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name, "en", { numeric: true }));
      if (entries.length > maximumOrdinaryAttemptsPerJob) {
        throw new OrdinaryAttemptFilesError("ordinary attempt job exceeds its attempt bound");
      }
      for (const entry of entries) {
        const match = attemptFilePattern.exec(entry.name);
        const attempt = Number(match?.[1]);
        if (!entry.isFile() || match === null || !Number.isSafeInteger(attempt)
          || attempt <= previousAttempt || (contiguous && attempt !== previousAttempt + 1)) {
          throw new OrdinaryAttemptFilesError("attempt record path is invalid");
        }
        const record = parse(await readReviewJson(join(directory, entry.name), maximumRecordBytes, true));
        const recordIdentity = identity(record);
        if (recordIdentity.reviewId !== review || recordIdentity.jobName !== job
          || recordIdentity.attempt !== attempt) {
          throw new OrdinaryAttemptFilesError("attempt record conflicts with its path");
        }
        records.push(record);
        previousAttempt = attempt;
      }
    }
  }
  return records;
}

async function assertSelectedDirectory(root: string, reviewId: string, jobName: string): Promise<void> {
  await assertPrivateDirectory(join(root, reviewId));
  await assertPrivateDirectory(join(root, reviewId, jobName));
}

async function directories(root: string): Promise<readonly string[]> {
  await assertPrivateDirectory(root);
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isDirectory())) throw new OrdinaryAttemptFilesError("attempt store contains a non-directory");
  return entries.map(({ name }) => name).sort();
}

async function writeRecord(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(dirname(path)));
  await ensurePrivateDirectory(dirname(path));
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary);
    await syncDirectory(dirname(path));
  }
}

async function recoverTemporaryRecords(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const match = temporaryFilePattern.exec(entry.name);
    if (match === null) continue;
    if (!entry.isFile()) throw new OrdinaryAttemptFilesError("attempt staging entry is not a regular file");
    const temporary = join(directory, entry.name);
    const finalName = match[1];
    if (finalName === undefined) throw new OrdinaryAttemptFilesError("attempt staging record has no final identity");
    const final = join(directory, finalName);
    const temporaryStat = await lstat(temporary);
    if (!temporaryStat.isFile() || temporaryStat.uid !== serviceUid()
      || (temporaryStat.mode & 0o777) !== 0o600 || temporaryStat.size > maximumRecordBytes) {
      throw new OrdinaryAttemptFilesError("attempt staging record is not private");
    }
    if (await pathExists(final)) {
      const finalStat = await lstat(final);
      if (!finalStat.isFile() || finalStat.uid !== serviceUid() || (finalStat.mode & 0o777) !== 0o600
        || temporaryStat.dev !== finalStat.dev || temporaryStat.ino !== finalStat.ino
        || temporaryStat.nlink !== 2 || finalStat.nlink !== 2) {
        throw new OrdinaryAttemptFilesError("attempt staging record conflicts with its publication");
      }
    } else if (temporaryStat.nlink !== 1) {
      throw new OrdinaryAttemptFilesError("unpublished attempt staging record has another owner");
    }
    await unlink(temporary);
    await syncDirectory(directory);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  await assertOwnedReviewDirectory(path);
  const metadata = await lstat(path);
  if ((metadata.mode & 0o777) !== 0o700) throw new OrdinaryAttemptFilesError("attempt directory is not private");
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  if (await pathExists(path)) {
    await assertPrivateDirectory(path);
    return;
  }
  await ownedReviewDirectory(path);
  await assertPrivateDirectory(path);
}

export async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isCode(error, "ENOENT")) return false; throw error; }
}

function recordPath(root: string, reviewId: string, jobName: string, attempt: number): string {
  return join(root, reviewId, jobName, `${attempt}.json`);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new OrdinaryAttemptFilesError("ordinary attempt records require a Linux identity");
  return uid;
}

export class OrdinaryAttemptFilesError extends Error {
  readonly name = "OrdinaryAttemptFilesError";
}
