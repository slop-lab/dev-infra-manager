import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ReviewPublicationFaults } from "./review-record-storage.js";

const stagedAcknowledgementPattern = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

export type ReviewAcknowledgementPublication = {
  readonly path: string;
  readonly serialized: string;
  readonly stagingRoot: string;
  readonly faults: ReviewPublicationFaults;
};

export type ReviewAcknowledgementRecovery = {
  readonly stagingRoot: string;
  readonly deliveredRoot: string;
};

export async function publishReviewAcknowledgement(publication: ReviewAcknowledgementPublication): Promise<void> {
  const stagedPath = join(publication.stagingRoot, `${basename(publication.path)}.${randomUUID()}.tmp`);
  const file = await open(
    stagedPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.writeFile(publication.serialized, "utf8");
    await file.chmod(0o600);
    await publication.faults.beforeFileSync?.();
    await file.sync();
  } finally {
    await file.close();
  }
  await publication.faults.beforePublish?.();
  try {
    await link(stagedPath, publication.path);
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    await unlink(stagedPath);
    await syncDirectory(publication.stagingRoot);
    throw error;
  }
  await publication.faults.beforeDirectorySync?.();
  await syncDirectory(dirname(publication.path));
  await publication.faults.afterPublish?.();
  await unlink(stagedPath);
  await syncDirectory(publication.stagingRoot);
}

export async function recoverReviewAcknowledgementStaging(recovery: ReviewAcknowledgementRecovery): Promise<void> {
  const entries = (await readdir(recovery.stagingRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const match = stagedAcknowledgementPattern.exec(entry.name);
    if (!entry.isFile() || match === null) {
      throw new ReviewAcknowledgementStorageError("review acknowledgement staging entry is invalid");
    }
    const finalName = match[1];
    if (finalName === undefined) {
      throw new ReviewAcknowledgementStorageError("review acknowledgement staging entry has no final identity");
    }
    await recoverStagedAcknowledgement(
      join(recovery.stagingRoot, entry.name),
      join(recovery.deliveredRoot, finalName),
      recovery
    );
  }
}

async function recoverStagedAcknowledgement(
  stagedPath: string,
  finalPath: string,
  recovery: ReviewAcknowledgementRecovery
): Promise<void> {
  const staged = await open(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stagedStat = await staged.stat();
    assertPrivateFile(stagedStat);
    if (stagedStat.nlink === 1) {
      await assertPathReference(stagedPath, stagedStat);
      await unlink(stagedPath);
      await syncDirectory(recovery.stagingRoot);
      return;
    }
    if (stagedStat.nlink !== 2) {
      throw new ReviewAcknowledgementStorageError("acknowledgement staging entry has unexpected links");
    }
    let final: FileHandle;
    try {
      final = await open(finalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      throw new ReviewAcknowledgementStorageError("published acknowledgement staging entry has no marker", { cause: error });
    }
    try {
      const finalStat = await final.stat();
      assertPrivateFile(finalStat);
      if (stagedStat.dev !== finalStat.dev || stagedStat.ino !== finalStat.ino
        || finalStat.nlink !== 2) {
        throw new ReviewAcknowledgementStorageError("published acknowledgement staging entry does not match its marker");
      }
      await assertPathReference(finalPath, finalStat);
      await syncDirectory(recovery.deliveredRoot);
      await assertPathReference(stagedPath, stagedStat);
      await unlink(stagedPath);
      await syncDirectory(recovery.stagingRoot);
    } finally {
      await final.close();
    }
  } finally {
    await staged.close();
  }
}

async function assertPathReference(path: string, expected: Stats): Promise<void> {
  const current = await lstat(path);
  assertPrivateFile(current);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new ReviewAcknowledgementStorageError("review acknowledgement staging reference changed during recovery");
  }
}

function assertPrivateFile(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== serviceUid() || (stat.mode & 0o777) !== 0o600) {
    throw new ReviewAcknowledgementStorageError("review acknowledgement records must be caller-owned mode-0600 regular files");
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
  if (uid === undefined) throw new ReviewAcknowledgementStorageError("native Git review requires a Linux user identity");
  return uid;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class ReviewAcknowledgementStorageError extends Error {
  readonly name = "ReviewAcknowledgementStorageError";
}
