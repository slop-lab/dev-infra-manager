import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { ownedReviewDirectory } from "./review-record-storage.js";

export type ProposalAcceptancePaths = {
  readonly failed: string;
  readonly failedStaging: string;
  readonly pending: string;
  readonly root: string;
  readonly staging: string;
};

const operations = new Map<string, Promise<void>>();
const recordPattern = /^[0-9a-f]{64}\.json$/;
const stagingPattern = /^([0-9a-f]{64}\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

export async function withProposalAcceptanceOperation<Result>(
  repository: string,
  operation: () => Promise<Result>
): Promise<Result> {
  const previous = operations.get(repository) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.catch(() => undefined).then(() => gate);
  operations.set(repository, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (operations.get(repository) === current) operations.delete(repository);
  }
}

export async function initializeProposalAcceptanceStorage(
  repository: string,
  maximumRecordBytes: number
): Promise<ProposalAcceptancePaths> {
  const root = join(repository, "dim-proposal-acceptance");
  const paths = {
    root,
    failed: join(root, "failed"),
    failedStaging: join(root, "failed-staging"),
    pending: join(root, "pending"),
    staging: join(root, "staging")
  };
  await ensurePrivateDirectory(root);
  await syncDirectory(repository);
  await ensurePrivateDirectory(paths.failed);
  await ensurePrivateDirectory(paths.failedStaging);
  await ensurePrivateDirectory(paths.pending);
  await ensurePrivateDirectory(paths.staging);
  await syncDirectory(root);
  await assertLayout(paths);
  await recoverStaging(paths.staging, paths.pending, maximumRecordBytes);
  await recoverStaging(paths.failedStaging, paths.failed, maximumRecordBytes);
  return paths;
}

export async function readProposalAcceptanceNames(directory: string): Promise<readonly string[]> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !recordPattern.test(entry.name)) {
      throw new ProposalAcceptanceStorageError("invalid proposal acceptance path");
    }
    names.push(entry.name);
  }
  return names;
}

export async function admitProposalAcceptanceRecord(
  directory: string,
  recordName: string,
  maximumRecords: number
): Promise<"available" | "existing"> {
  const names = await readProposalAcceptanceNames(directory);
  if (names.includes(recordName)) {
    if (names.length > maximumRecords) {
      throw new ProposalAcceptanceStorageError("proposal acceptance capacity exceeded");
    }
    return "existing";
  }
  if (names.length >= maximumRecords) {
    throw new ProposalAcceptanceStorageError("proposal acceptance capacity exceeded");
  }
  return "available";
}

export async function removeProposalAcceptanceRecord(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

export async function syncProposalAcceptanceDirectory(path: string): Promise<void> {
  await syncDirectory(path);
}

async function recoverStaging(stagingRoot: string, recordRoot: string, maximumRecordBytes: number): Promise<void> {
  const entries = (await readdir(stagingRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const match = stagingPattern.exec(entry.name);
    if (!entry.isFile() || match === null || match[1] === undefined) {
      throw new ProposalAcceptanceStorageError("invalid proposal acceptance staging path");
    }
    const stagedPath = join(stagingRoot, entry.name);
    const finalPath = join(recordRoot, match[1]);
    const staged = await readPrivateFile(stagedPath, maximumRecordBytes);
    if (staged.nlink === 2) {
      const final = await readPrivateFile(finalPath, maximumRecordBytes);
      if (final.nlink !== 2 || final.dev !== staged.dev || final.ino !== staged.ino) {
        throw new ProposalAcceptanceStorageError("proposal acceptance staging entry does not match its record");
      }
    } else if (staged.nlink === 1) {
      if (await readPrivateFileIfPresent(finalPath, maximumRecordBytes) !== undefined) {
        throw new ProposalAcceptanceStorageError("proposal acceptance staging entry conflicts with its record");
      }
    } else {
      throw new ProposalAcceptanceStorageError("proposal acceptance staging link count is invalid");
    }
    await unlink(stagedPath);
    await syncDirectory(stagingRoot);
  }
}

async function readPrivateFile(path: string, maximumRecordBytes: number): Promise<Stats> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== serviceUid() || (stat.mode & 0o777) !== 0o600
      || stat.size > maximumRecordBytes) {
      throw new ProposalAcceptanceStorageError("proposal acceptance record is not a bounded private file");
    }
    return stat;
  } finally {
    await file.close();
  }
}

async function readPrivateFileIfPresent(path: string, maximumRecordBytes: number): Promise<Stats | undefined> {
  try {
    return await readPrivateFile(path, maximumRecordBytes);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
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

async function assertLayout(paths: ProposalAcceptancePaths): Promise<void> {
  const entries = await readdir(paths.root, { withFileTypes: true });
  const allowed = new Set([basename(paths.failed), basename(paths.failedStaging), basename(paths.pending), basename(paths.staging)]);
  if (entries.length !== allowed.size || entries.some((entry) => !entry.isDirectory() || !allowed.has(entry.name))) {
    throw new ProposalAcceptanceStorageError("proposal acceptance store layout is invalid");
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== serviceUid() || (stat.mode & 0o777) !== 0o700) {
    throw new ProposalAcceptanceStorageError("proposal acceptance directory is not private");
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
  if (uid === undefined) throw new ProposalAcceptanceStorageError("proposal acceptance storage requires a Linux user identity");
  return uid;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class ProposalAcceptanceStorageError extends Error {
  readonly name = "ProposalAcceptanceStorageError";
}
