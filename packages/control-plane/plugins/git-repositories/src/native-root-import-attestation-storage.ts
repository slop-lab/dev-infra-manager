import type { BigIntStats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { assertPrivateDirectory, inspectDurableNativeRootBundleIdentity, NativeRootImportBundleError } from "./native-root-import-storage.js";

type NativeRootStorageIdentityInput = {
  readonly stateDirectory: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly importNonce: string;
  readonly bundleSize: number;
  readonly repository: string;
};

export async function captureNativeRootStorageIdentity(
  input: NativeRootStorageIdentityInput
): Promise<string> {
  await assertPrivateDirectory(input.repository);
  const bundle = await inspectDurableNativeRootBundleIdentity(
    input.stateDirectory,
    input.projectId,
    input.repositoryId,
    input.importNonce,
    input.bundleSize
  );
  const objects = join(input.repository, "objects");
  const entries: string[] = [];
  await captureEntry(objects, objects, entries);
  const repository = await lstat(input.repository, { bigint: true });
  assertOwnedMetadata(repository, "directory");
  return JSON.stringify({ bundle, repository: ["directory", ...directoryAuthorityFields(repository)], objects: entries });
}

async function captureEntry(root: string, path: string, entries: string[]): Promise<void> {
  const metadata = await lstat(path, { bigint: true });
  const kind = metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "invalid";
  if (kind === "invalid") throw new NativeRootImportBundleError("native root object storage entry is invalid");
  assertOwnedMetadata(metadata, kind);
  entries.push(JSON.stringify([relative(root, path), kind, identityFields(metadata)]));
  if (kind === "directory") {
    for (const name of (await readdir(path)).sort()) await captureEntry(root, join(path, name), entries);
  }
}

function assertOwnedMetadata(metadata: BigIntStats, kind: "directory" | "file"): void {
  const owner = process.geteuid?.();
  const expectedKind = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (!expectedKind || metadata.isSymbolicLink() || owner === undefined || metadata.uid !== BigInt(owner)
    || (metadata.mode & 0o022n) !== 0n || (kind === "file" && metadata.nlink !== 1n)) {
    throw new NativeRootImportBundleError("native root object storage ownership is invalid");
  }
}

function directoryAuthorityFields(metadata: BigIntStats): readonly string[] {
  return [metadata.dev, metadata.ino, metadata.mode, metadata.uid].map(String);
}

function identityFields(metadata: BigIntStats): readonly string[] {
  return [metadata.dev, metadata.ino, metadata.mode, metadata.uid, metadata.nlink, metadata.size,
    metadata.mtimeNs, metadata.ctimeNs].map(String);
}
