import { lstat, mkdir, readlink, rename, symlink, unlink } from "node:fs/promises";
import path from "node:path";

export type ManagedSymlinkSnapshot =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly target: string };

export async function installManagedSymlink(linkPath: string, target: string, managedRoot: string): Promise<void> {
  const absoluteLink = path.resolve(linkPath);
  const absoluteTarget = path.resolve(target);
  await mkdir(path.dirname(absoluteLink), { recursive: true, mode: 0o700 });
  await snapshotManagedSymlink(absoluteLink, managedRoot);
  await replaceSymlink(absoluteLink, absoluteTarget);
}

export async function snapshotManagedSymlink(
  linkPath: string,
  managedRoot: string
): Promise<ManagedSymlinkSnapshot> {
  const absoluteLink = path.resolve(linkPath);
  const absoluteManagedRoot = path.resolve(managedRoot);
  try {
    const existing = await lstat(absoluteLink);
    if (!existing.isSymbolicLink()) throw new Error(`${absoluteLink} already exists and is not managed by DIM installer`);
    const target = await readlink(absoluteLink);
    const resolvedTarget = path.resolve(path.dirname(absoluteLink), target);
    if (!isWithin(resolvedTarget, absoluteManagedRoot)) {
      throw new Error(`${absoluteLink} already exists and is not managed by DIM installer`);
    }
    return { kind: "present", target };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    throw error;
  }
}

export async function restoreManagedSymlink(
  linkPath: string,
  snapshot: ManagedSymlinkSnapshot
): Promise<void> {
  if (snapshot.kind === "absent") {
    await unlink(linkPath);
    return;
  }
  await replaceSymlink(linkPath, snapshot.target);
}

async function replaceSymlink(linkPath: string, target: string): Promise<void> {
  const absoluteLink = path.resolve(linkPath);
  const temporary = `${absoluteLink}.tmp-${process.pid}-${Date.now()}`;
  await symlink(target, temporary);
  try {
    await rename(temporary, absoluteLink);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
