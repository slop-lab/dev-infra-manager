import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

export async function assertDurableNativeRootBundle(
  stateDirectory: string,
  projectId: string,
  repositoryId: string,
  importNonce: string,
  expectedDigest: string,
  expectedSize: number
): Promise<void> {
  const path = rootBundlePath(stateDirectory, projectId, repositoryId, importNonce);
  await assertPrivateDirectory(join(stateDirectory, projectId));
  await assertPrivateDirectory(rootBundleDirectory(stateDirectory, projectId, repositoryId));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    throw new NativeRootImportBundleError("durable root bundle file is invalid", { cause: error });
  });
  try {
    const before = await file.stat({ bigint: true });
    assertBundleMetadata(before, expectedSize);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < expectedSize) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, expectedSize - position), position);
      if (bytesRead === 0) throw new NativeRootImportBundleError("durable root bundle file is truncated");
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!sameBundleIdentity(before, after) || !sameBundleIdentity(before, current)) {
      throw new NativeRootImportBundleError("durable root bundle file changed during inspection");
    }
    if (digest.digest("hex") !== expectedDigest) {
      throw new NativeRootImportBundleError("durable root bundle digest is invalid");
    }
  } finally {
    await file.close();
  }
}

export async function inspectDurableNativeRootBundleIdentity(
  stateDirectory: string,
  projectId: string,
  repositoryId: string,
  importNonce: string,
  expectedSize: number
): Promise<string> {
  const path = rootBundlePath(stateDirectory, projectId, repositoryId, importNonce);
  await assertPrivateDirectory(join(stateDirectory, projectId));
  await assertPrivateDirectory(rootBundleDirectory(stateDirectory, projectId, repositoryId));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    throw new NativeRootImportBundleError("durable root bundle file is invalid", { cause: error });
  });
  try {
    const opened = await file.stat({ bigint: true });
    assertBundleMetadata(opened, expectedSize);
    const current = await lstat(path, { bigint: true });
    if (!sameBundleIdentity(opened, current)) {
      throw new NativeRootImportBundleError("durable root bundle file changed during inspection");
    }
    return bundleIdentity(opened);
  } finally {
    await file.close();
  }
}

export function rootBundleDirectory(stateDirectory: string, projectId: string, repositoryId: string): string {
  return join(stateDirectory, projectId, `.dim-import-${repositoryId}`);
}

export function rootBundlePath(stateDirectory: string, projectId: string, repositoryId: string, importNonce: string): string {
  return join(rootBundleDirectory(stateDirectory, projectId, repositoryId), `${importNonce}.bundle`);
}

export async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  const owner = process.geteuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || owner === undefined || metadata.uid !== owner
    || (metadata.mode & 0o777) !== 0o700) {
    throw new NativeRootImportBundleError("root import staging directory is invalid");
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function sameBundleIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function assertBundleMetadata(metadata: BigIntStats, expectedSize: number): void {
  const owner = process.geteuid?.();
  if (!metadata.isFile() || owner === undefined || metadata.uid !== BigInt(owner)
    || (metadata.mode & 0o777n) !== 0o600n || metadata.nlink !== 1n
    || metadata.size !== BigInt(expectedSize)) {
    throw new NativeRootImportBundleError("durable root bundle file is invalid");
  }
}

function bundleIdentity(metadata: BigIntStats): string {
  return [metadata.dev, metadata.ino, metadata.size, metadata.mode, metadata.uid, metadata.nlink,
    metadata.mtimeNs, metadata.ctimeNs].map(String).join(":");
}

export class NativeRootImportBundleError extends Error {
  readonly name = "NativeRootImportBundleError";
}
