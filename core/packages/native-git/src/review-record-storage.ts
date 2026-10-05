import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type ReviewPublicationFaults = {
  readonly beforeFileSync?: () => void | Promise<void>;
  readonly beforePublish?: () => void | Promise<void>;
};

export type ReviewPublication = {
  readonly path: string;
  readonly serialized: string;
  readonly stagingRoot: string;
  readonly faults: ReviewPublicationFaults;
};

export type ReviewStagingRecovery = {
  readonly stagingRoot: string;
  readonly proposalRoot: string;
};

export async function writeImmutableReviewRecord(path: string, value: unknown): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}

export async function publishReviewRecord(publication: ReviewPublication): Promise<void> {
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
  } catch (error) {
    await file.close();
    await removeStaged(stagedPath);
    throw error;
  }
  await file.close();
  try {
    await publication.faults.beforePublish?.();
    await link(stagedPath, publication.path);
    await syncDirectory(dirname(publication.path));
  } finally {
    await removeStaged(stagedPath);
  }
  await syncDirectory(publication.stagingRoot);
}

export async function readReviewJson(path: string, maximumBytes: number): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== serviceUid() || (stat.mode & 0o777) !== 0o600) {
      throw new ReviewRecordStorageError("review record must be a caller-owned mode-0600 regular file");
    }
    if (stat.size > maximumBytes) throw new ReviewRecordStorageError("review record exceeds the storage bound");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}

export async function recoverPublishedReviewStaging(recovery: ReviewStagingRecovery): Promise<void> {
  for (const entry of await readdir(recovery.stagingRoot, { withFileTypes: true })) {
    const match = /^([0-9a-f]{64}\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.exec(entry.name);
    if (!entry.isFile() || match === null) throw new ReviewRecordStorageError("review staging entry is invalid");
    const finalName = match[1];
    if (finalName === undefined) throw new ReviewRecordStorageError("review staging entry has no final identity");
    const stagedPath = join(recovery.stagingRoot, entry.name);
    const finalPath = join(recovery.proposalRoot, finalName);
    const staged = await open(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stagedStat = await staged.stat();
      assertPrivateReviewFile(stagedStat);
      const final = await open(finalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const finalStat = await final.stat();
        assertPrivateReviewFile(finalStat);
        if (stagedStat.dev !== finalStat.dev || stagedStat.ino !== finalStat.ino
          || stagedStat.nlink !== 2 || finalStat.nlink !== 2) {
          throw new ReviewRecordStorageError("review staging entry does not match its published review");
        }
      } finally {
        await final.close();
      }
    } finally {
      await staged.close();
    }
    await unlink(stagedPath);
    await syncDirectory(recovery.stagingRoot);
  }
}

export async function ownedReviewDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertOwnedReviewDirectory(path);
  await chmod(path, 0o700);
}

export async function assertOwnedReviewDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== serviceUid()) {
    throw new ReviewRecordStorageError("review store must contain caller-owned directories");
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

function assertPrivateReviewFile(stat: Stats): void {
  if (!stat.isFile() || stat.uid !== serviceUid() || (stat.mode & 0o777) !== 0o600) {
    throw new ReviewRecordStorageError("review staging records must be caller-owned mode-0600 regular files");
  }
}

async function removeStaged(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ReviewRecordStorageError("native Git review requires a Linux user identity");
  return uid;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class ReviewRecordStorageError extends Error {
  readonly name = "ReviewRecordStorageError";
}
