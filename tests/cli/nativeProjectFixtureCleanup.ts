import { chmod, lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

const fixtureParent = "/tmp";
const fixturePrefixes = ["dim-native-cli-", "dim-native-draft-root-read-"];

export async function prepareNativeProjectFixtureRootForRemoval(root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  if (dirname(resolvedRoot) !== fixtureParent || !fixturePrefixes.some((prefix) => basename(resolvedRoot).startsWith(prefix))) {
    throw new NativeProjectFixtureCleanupError("native Project fixture cleanup root is outside its temporary namespace");
  }
  const metadata = await lstat(resolvedRoot);
  const owner = process.geteuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || owner === undefined || metadata.uid !== owner) {
    throw new NativeProjectFixtureCleanupError("native Project fixture cleanup root is not an owned directory");
  }
  if (await realpath(resolvedRoot) !== resolvedRoot) {
    throw new NativeProjectFixtureCleanupError("native Project fixture cleanup root is not canonical");
  }
  await prepareOwnedDirectories(resolvedRoot, resolvedRoot, owner);
}

async function prepareOwnedDirectories(root: string, directory: string, owner: number): Promise<void> {
  const resolvedDirectory = resolve(directory);
  if (resolvedDirectory !== root && !resolvedDirectory.startsWith(`${root}${sep}`)) {
    throw new NativeProjectFixtureCleanupError("native Project fixture cleanup escaped its temporary root");
  }
  const metadata = await lstat(resolvedDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== owner) return;
  await chmod(resolvedDirectory, 0o700);
  const entries = await readdir(resolvedDirectory);
  await Promise.all(entries.map(async (entry) => {
    const child = join(resolvedDirectory, entry);
    const childMetadata = await lstat(child);
    if (childMetadata.isDirectory() && !childMetadata.isSymbolicLink() && childMetadata.uid === owner) {
      await prepareOwnedDirectories(root, child, owner);
    }
  }));
}

export class NativeProjectFixtureCleanupError extends Error {
  readonly name = "NativeProjectFixtureCleanupError";
}
