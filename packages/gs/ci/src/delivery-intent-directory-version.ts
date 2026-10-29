import { lstat } from "node:fs/promises";

export type DeliveryIntentDirectoryVersion = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
};

export async function inspectDeliveryIntentDirectory(path: string): Promise<DeliveryIntentDirectoryVersion> {
  const stat = await lstat(path, { bigint: true });
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || uid === undefined
    || stat.uid !== BigInt(uid) || (stat.mode & 0o777n) !== 0o700n || stat.nlink < 2n) {
    throw new DeliveryIntentDirectoryVersionError(
      "authoritative delivery intent directory is not private"
    );
  }
  return { dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

export function sameDeliveryIntentDirectoryIdentity(
  left: DeliveryIntentDirectoryVersion,
  right: DeliveryIntentDirectoryVersion
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameDeliveryIntentDirectoryVersion(
  left: DeliveryIntentDirectoryVersion,
  right: DeliveryIntentDirectoryVersion
): boolean {
  return sameDeliveryIntentDirectoryIdentity(left, right)
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export class DeliveryIntentDirectoryVersionError extends Error {
  readonly name = "DeliveryIntentDirectoryVersionError";
}
