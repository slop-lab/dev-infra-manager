import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  authoritativeOrdinaryStatusSchema,
  type AuthoritativeOrdinaryStatus
} from "./authoritative-ordinary-status-schema.js";

const maximumRecordBytes = 256 * 1024;
const recordPattern = /^([1-9][0-9]*)\.json$/;
const stagingPattern = /^\.([1-9][0-9]*\.json)\.([0-9a-f]{64})\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

export type AuthoritativeOrdinaryStatusPublicationFaults = {
  readonly beforeWrite?: () => void | Promise<void>;
  readonly beforeFileSync?: () => void | Promise<void>;
  readonly afterPublish?: () => void | Promise<void>;
};

export type OrdinaryStatusDirectoryRead = {
  readonly statuses: readonly AuthoritativeOrdinaryStatus[];
  readonly stagingPaths: readonly string[];
};

type StagedRecord = {
  readonly path: string;
  readonly finalName: string;
  readonly expectedDigest: string;
  readonly metadata: Stats;
  readonly status: AuthoritativeOrdinaryStatus | undefined;
};

type FinalRecord = {
  readonly name: string;
  readonly metadata: Stats;
  readonly status: AuthoritativeOrdinaryStatus;
};

type StatusDirectoryContext = {
  readonly directory: string;
  readonly reviewId: string;
  readonly jobName: string;
  readonly finalNames: ReadonlySet<string>;
};

export async function publishAuthoritativeOrdinaryStatus(
  path: string,
  serialized: string,
  faults: AuthoritativeOrdinaryStatusPublicationFaults
): Promise<void> {
  if (Buffer.byteLength(serialized, "utf8") > maximumRecordBytes) {
    throw new OrdinaryStatusFilesError("ordinary status record exceeds the storage bound");
  }
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
  const stagedPath = join(dirname(path), `.${basename(path)}.${digest}.${randomUUID()}.tmp`);
  const file = await open(stagedPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await faults.beforeWrite?.();
    await file.writeFile(serialized, "utf8");
    await faults.beforeFileSync?.();
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(stagedPath, path);
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      await unlink(stagedPath);
      await syncDirectory(dirname(path));
    }
    throw error;
  }
  await syncDirectory(dirname(path));
  await faults.afterPublish?.();
  await unlink(stagedPath);
  await syncDirectory(dirname(path));
}

export async function readOrdinaryStatusDirectory(
  directory: string,
  reviewId: string,
  jobName: string
): Promise<OrdinaryStatusDirectoryRead> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, "en", { numeric: true }));
  const finalNames = new Set(entries.flatMap((entry) => recordPattern.test(entry.name) ? [entry.name] : []));
  const context = { directory, reviewId, jobName, finalNames };
  const stagedRecords: StagedRecord[] = [];
  const finalRecords: FinalRecord[] = [];
  for (const entry of entries) {
    const staged = stagingPattern.exec(entry.name);
    const final = recordPattern.exec(entry.name);
    if (!entry.isFile() || (staged === null && final === null)) {
      throw new OrdinaryStatusFilesError("ordinary status record path is invalid");
    }
    if (staged !== null) {
      stagedRecords.push(await readStagedRecord(context, entry.name, staged));
    } else if (final !== null) {
      finalRecords.push(await readFinalRecord(context, entry.name, final));
    }
  }
  validateStagingPublications(stagedRecords, finalRecords);
  return { statuses: finalRecords.map(({ status }) => status), stagingPaths: stagedRecords.map(({ path }) => path) };
}

export async function removeOrdinaryStatusStaging(paths: readonly string[]): Promise<void> {
  const directories = new Set<string>();
  for (const path of paths) {
    await unlink(path);
    directories.add(dirname(path));
  }
  await Promise.all([...directories].map(syncDirectory));
}

async function readStagedRecord(
  context: StatusDirectoryContext,
  name: string,
  match: RegExpExecArray
): Promise<StagedRecord> {
  const finalName = match[1];
  const expectedDigest = match[2];
  if (finalName === undefined || expectedDigest === undefined) throw new OrdinaryStatusFilesError("status staging identity is missing");
  const path = join(context.directory, name);
  const { metadata, serialized } = await readPrivateFile(path);
  const actualDigest = createHash("sha256").update(serialized, "utf8").digest("hex");
  if (actualDigest !== expectedDigest) {
    if (metadata.nlink !== 1 || context.finalNames.has(finalName) || parsesJson(serialized)) {
      throw new OrdinaryStatusFilesError("ordinary status staging record is inconsistent");
    }
    return { path, finalName, expectedDigest, metadata, status: undefined };
  }
  const status = authoritativeOrdinaryStatusSchema.parse(JSON.parse(serialized));
  assertPathIdentity(status, context, Number(recordPattern.exec(finalName)?.[1]));
  return { path, finalName, expectedDigest, metadata, status };
}

async function readFinalRecord(
  context: StatusDirectoryContext,
  name: string,
  match: RegExpExecArray
): Promise<FinalRecord> {
  const { metadata, serialized } = await readPrivateFile(join(context.directory, name));
  const status = authoritativeOrdinaryStatusSchema.parse(JSON.parse(serialized));
  assertPathIdentity(status, context, Number(match[1]));
  return { name, metadata, status };
}

function validateStagingPublications(stagedRecords: readonly StagedRecord[], finalRecords: readonly FinalRecord[]): void {
  for (const staged of stagedRecords) {
    const final = finalRecords.find((candidate) => candidate.name === staged.finalName);
    if (final === undefined) {
      if (staged.metadata.nlink !== 1) throw new OrdinaryStatusFilesError("unpublished status staging has another owner");
      continue;
    }
    if (staged.status === undefined) throw new OrdinaryStatusFilesError("published status staging is incomplete");
    const sameInode = staged.metadata.dev === final.metadata.dev && staged.metadata.ino === final.metadata.ino;
    const published = sameInode && staged.metadata.nlink === 2 && final.metadata.nlink === 2;
    const replayLoser = !sameInode && staged.metadata.nlink === 1 && final.metadata.nlink === 1
      && isDeepStrictEqual(staged.status, final.status);
    if (!published && !replayLoser) {
      throw new OrdinaryStatusFilesError("ordinary status staging conflicts with its publication");
    }
  }
  for (const final of finalRecords) {
    const staged = stagedRecords.filter((candidate) => candidate.finalName === final.name);
    if (staged.length === 0 && final.metadata.nlink !== 1) {
      throw new OrdinaryStatusFilesError("ordinary status record must have one owner");
    }
    if (staged.length > 1) throw new OrdinaryStatusFilesError("ordinary status has multiple staging owners");
  }
}

async function readPrivateFile(path: string): Promise<{ readonly metadata: Stats; readonly serialized: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== serviceUid() || (metadata.mode & 0o777) !== 0o600
      || metadata.size > maximumRecordBytes) {
      throw new OrdinaryStatusFilesError("ordinary status record is not private");
    }
    return { metadata, serialized: await file.readFile("utf8") };
  } finally {
    await file.close();
  }
}

function assertPathIdentity(status: AuthoritativeOrdinaryStatus, context: StatusDirectoryContext, attempt: number): void {
  if (status.reviewId !== context.reviewId || status.payload.descriptor.jobName !== context.jobName
    || status.payload.attempt !== attempt) {
    throw new OrdinaryStatusFilesError("ordinary status record conflicts with its path");
  }
}

function parsesJson(serialized: string): boolean {
  try { JSON.parse(serialized); return true; } catch (error) { if (error instanceof SyntaxError) return false; throw error; }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new OrdinaryStatusFilesError("ordinary status records require a Linux identity");
  return uid;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class OrdinaryStatusFilesError extends Error {
  readonly name = "OrdinaryStatusFilesError";
}
