import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NativeRootImportBundleError, syncDirectory } from "./native-root-import-storage.js";

const packName = /^(pack-(?:[0-9a-f]{40}|[0-9a-f]{64}))\.(pack|idx|rev|bitmap|keep)$/;

export async function syncNativeRootObjectStore(repository: string): Promise<void> {
  const objects = join(repository, "objects");
  const packDirectory = join(objects, "pack");
  await assertOwnedDirectory(repository);
  await assertOwnedDirectory(objects);
  await assertOwnedDirectory(packDirectory);
  const names = (await readdir(packDirectory)).sort();
  const packs = new Map<string, Set<string>>();
  for (const name of names) {
    const match = packName.exec(name);
    const base = match?.[1];
    const extension = match?.[2];
    if (base === undefined || extension === undefined) {
      throw new NativeRootImportBundleError("native root object pack entry is invalid");
    }
    const group = packs.get(base) ?? new Set<string>();
    group.add(extension);
    packs.set(base, group);
  }
  if (packs.size === 0 || [...packs.values()].some((group) => !group.has("pack") || !group.has("idx"))) {
    throw new NativeRootImportBundleError("native root object pack pair is incomplete");
  }
  for (const name of names) await syncOwnedFile(join(packDirectory, name));
  await syncDirectory(packDirectory);
  await syncDirectory(objects);
  await syncDirectory(repository);
}

export async function syncNativeRootProtectedRef(repository: string, protectedRef: string): Promise<void> {
  const path = join(repository, protectedRef);
  await syncOwnedFile(path);
  for (let directory = dirname(path); directory !== repository; directory = dirname(directory)) {
    await assertOwnedDirectory(directory);
    await syncDirectory(directory);
  }
  await assertOwnedDirectory(repository);
  await syncDirectory(repository);
}

async function syncOwnedFile(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    throw new NativeRootImportBundleError("native root durable Git file is unavailable", { cause: error });
  });
  try {
    const before = await file.stat({ bigint: true });
    const owner = process.geteuid?.();
    if (!before.isFile() || owner === undefined || before.uid !== BigInt(owner)
      || before.nlink !== 1n || (before.mode & 0o022n) !== 0n) {
      throw new NativeRootImportBundleError("native root durable Git file is unsafe");
    }
    await file.sync();
    const after = await file.stat({ bigint: true });
    const pathIdentity = await lstat(path, { bigint: true });
    if (!sameFile(before, after) || !sameFile(before, pathIdentity)) {
      throw new NativeRootImportBundleError("native root durable Git file changed during sync");
    }
  } finally {
    await file.close();
  }
}

async function assertOwnedDirectory(path: string): Promise<void> {
  const metadata = await lstat(path, { bigint: true });
  const owner = process.geteuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || owner === undefined
    || metadata.uid !== BigInt(owner) || (metadata.mode & 0o022n) !== 0n) {
    throw new NativeRootImportBundleError("native root durable Git directory is unsafe");
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return right.isFile() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
