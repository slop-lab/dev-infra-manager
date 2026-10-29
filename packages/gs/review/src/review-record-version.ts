import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";

export type ReviewRecordVersion = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly links: bigint;
  readonly size: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly changedNanoseconds: bigint;
};

export type VersionedReviewRecord = {
  readonly value: unknown;
  readonly version: ReviewRecordVersion;
  readonly fingerprint: string;
};

export async function readVersionedReviewRecord(path: string, maximumBytes: number): Promise<VersionedReviewRecord> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    assertPrivateRecord(before, maximumBytes);
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    const version = recordVersion(before);
    if (!sameReviewRecordVersion(version, recordVersion(after))
      || !sameReviewRecordVersion(version, recordVersion(current))) {
      throw new ReviewRecordVersionError("authoritative native review record changed during inspection");
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return { value, version, fingerprint: versionFingerprint(version) };
  } finally {
    await file.close();
  }
}

export async function inspectReviewRecordVersion(
  path: string,
  maximumBytes: number,
): Promise<Pick<VersionedReviewRecord, "version" | "fingerprint">> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat({ bigint: true });
    assertPrivateRecord(opened, maximumBytes);
    const current = await lstat(path, { bigint: true });
    const version = recordVersion(opened);
    if (!sameReviewRecordVersion(version, recordVersion(current))) {
      throw new ReviewRecordVersionError("authoritative native review record path changed during inspection");
    }
    return { version, fingerprint: versionFingerprint(version) };
  } finally {
    await file.close();
  }
}

export function sameReviewRecordVersion(left: ReviewRecordVersion, right: ReviewRecordVersion): boolean {
  return left.device === right.device && left.inode === right.inode && left.uid === right.uid
    && left.mode === right.mode && left.links === right.links && left.size === right.size
    && left.modifiedNanoseconds === right.modifiedNanoseconds
    && left.changedNanoseconds === right.changedNanoseconds;
}

function assertPrivateRecord(metadata: BigIntStats, maximumBytes: number): void {
  const uid = process.getuid?.();
  if (!metadata.isFile() || uid === undefined || metadata.uid !== BigInt(uid)
    || (metadata.mode & 0o777n) !== 0o600n || metadata.nlink !== 1n
    || metadata.size > BigInt(maximumBytes)) {
    throw new ReviewRecordVersionError("authoritative native review record is not a bounded private single-link file");
  }
}

function recordVersion(metadata: BigIntStats): ReviewRecordVersion {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    uid: metadata.uid,
    mode: metadata.mode,
    links: metadata.nlink,
    size: metadata.size,
    modifiedNanoseconds: metadata.mtimeNs,
    changedNanoseconds: metadata.ctimeNs,
  };
}

function versionFingerprint(version: ReviewRecordVersion): string {
  const serialized = [version.device, version.inode, version.uid, version.mode, version.links, version.size,
    version.modifiedNanoseconds, version.changedNanoseconds].map(String).join(":");
  return createHash("sha256").update("dim-authoritative-review-file-version-v1\0").update(serialized).digest("hex");
}

export class ReviewRecordVersionError extends Error {
  readonly name = "ReviewRecordVersionError";
}
