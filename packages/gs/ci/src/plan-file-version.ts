import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";

export type GitCiPlanFileVersion = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
};

type ReadGitCiPlanFileInput = {
  readonly path: string;
  readonly maximumBytes: number;
  readonly expectedVersion?: GitCiPlanFileVersion;
  readonly readBody: boolean;
};

export type GitCiPlanFile = {
  readonly version: GitCiPlanFileVersion;
  readonly serialized?: string;
};

export async function assertPrivateGitCiPlanDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== serviceUid()
    || (stat.mode & 0o777) !== 0o700) {
    throw new GitCiPlanFileVersionError("Git CI plan directory must be caller-owned mode-0700");
  }
}

export async function readGitCiPlanFile(input: ReadGitCiPlanFileInput): Promise<GitCiPlanFile> {
  let file;
  try {
    file = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new GitCiPlanFileVersionError("Git CI plan file version changed", { cause: error });
  }
  try {
    const before = await file.stat({ bigint: true });
    const version = planFileVersion(before, input.maximumBytes);
    if (input.expectedVersion !== undefined && !sameGitCiPlanFileVersion(version, input.expectedVersion)) {
      throw new GitCiPlanFileVersionError("Git CI plan file version changed");
    }
    const serialized = input.readBody ? await file.readFile("utf8") : undefined;
    const after = await file.stat({ bigint: true });
    const pathVersion = planFileVersion(await lstat(input.path, { bigint: true }), input.maximumBytes);
    if (!sameGitCiPlanFileVersion(version, planFileVersion(after, input.maximumBytes))
      || !sameGitCiPlanFileVersion(version, pathVersion)) {
      throw new GitCiPlanFileVersionError("Git CI plan file version changed during verification");
    }
    return serialized === undefined ? { version } : { version, serialized };
  } finally {
    await file.close();
  }
}

export function sameGitCiPlanFileVersion(
  left: GitCiPlanFileVersion,
  right: GitCiPlanFileVersion
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.uid === right.uid && left.mode === right.mode && left.nlink === right.nlink;
}

function planFileVersion(stat: BigIntStats, maximumBytes: number): GitCiPlanFileVersion {
  if (!stat.isFile() || stat.uid !== BigInt(serviceUid()) || (stat.mode & 0o777n) !== 0o600n
    || stat.nlink !== 1n || stat.size > BigInt(maximumBytes)) {
    throw new GitCiPlanFileVersionError("Git CI plan must be a bounded caller-owned mode-0600 single-link file");
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink
  };
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new GitCiPlanFileVersionError("Git CI plan verification requires a Linux identity");
  return uid;
}

export class GitCiPlanFileVersionError extends Error {
  readonly name = "GitCiPlanFileVersionError";
}
