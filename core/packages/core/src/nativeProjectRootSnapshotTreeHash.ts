import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, readdir } from "node:fs/promises";
import type { GitObjectFormat } from "./nativeGitCandidateProcess.js";
import { nativeRootSnapshotTreeLimits as limits } from "./nativeGitRootSnapshotTree.js";

type HashState = {
  entries: number;
  materializedBytes: number;
  treeBytes: number;
};

type HashContext = {
  readonly objectFormat: GitObjectFormat;
  readonly depth: number;
  readonly state: HashState;
};

type HashedEntry = {
  readonly mode: "40000" | "100644" | "100755" | "120000";
  readonly name: Buffer;
  readonly objectId: Buffer;
};

export async function assertNativeProjectRootSnapshotTree(
  root: string,
  expectedTree: string
): Promise<void> {
  const objectFormat = objectFormatOf(expectedTree);
  if (objectFormat === undefined) invalidTree();
  const state: HashState = { entries: 0, materializedBytes: 0, treeBytes: 0 };
  const actualTree = await hashDirectory(Buffer.from(root), { objectFormat, depth: 0, state });
  if (actualTree.toString("hex") !== expectedTree) invalidTree();
}

async function hashDirectory(directory: Buffer, context: HashContext): Promise<Buffer> {
  if (context.depth > limits.maximumDepth) invalidTree();
  const entries: HashedEntry[] = [];
  for (const directoryEntry of await readdir(directory, { encoding: "buffer", withFileTypes: true })) {
    context.state.entries += 1;
    if (context.state.entries > limits.maximumEntries) invalidTree();
    const target = Buffer.concat([directory, Buffer.from("/"), directoryEntry.name]);
    const metadata = await lstat(target);
    let entry: HashedEntry;
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      entry = { mode: "40000", name: directoryEntry.name,
        objectId: await hashDirectory(target, { ...context, depth: context.depth + 1 }) };
    } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
      const mode = metadata.mode & 0o111 ? "100755" : "100644";
      entry = { mode, name: directoryEntry.name,
        objectId: hashObject(context.objectFormat, "blob",
          await readBoundedFile(target, metadata.size, context.state)) };
    } else if (metadata.isSymbolicLink()) {
      const link = await readlink(target, { encoding: "buffer" });
      addMaterializedBytes(context.state, link.length, limits.maximumLinkBytes);
      entry = { mode: "120000", name: directoryEntry.name,
        objectId: hashObject(context.objectFormat, "blob", link) };
    } else {
      invalidTree();
    }
    entries.push(entry);
  }
  entries.sort((left, right) => Buffer.compare(sortName(left), sortName(right)));
  const bytes = Buffer.concat(entries.map(encodeTreeEntry));
  context.state.treeBytes += bytes.length;
  if (context.state.treeBytes > limits.maximumTreeBytes) invalidTree();
  return hashObject(context.objectFormat, "tree", bytes);
}

async function readBoundedFile(target: Buffer, size: number, state: HashState): Promise<Buffer> {
  addMaterializedBytes(state, size, limits.maximumBlobBytes);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== size) invalidTree();
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, offset);
      if (result.bytesRead === 0) invalidTree();
      offset += result.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, size)).bytesRead !== 0) invalidTree();
    return bytes;
  } finally {
    await handle.close();
  }
}

function addMaterializedBytes(state: HashState, size: number, itemLimit: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > itemLimit
    || size > limits.maximumMaterializedBytes - state.materializedBytes) invalidTree();
  state.materializedBytes += size;
}

function encodeTreeEntry(entry: HashedEntry): Buffer {
  return Buffer.concat([Buffer.from(`${entry.mode} `, "ascii"), entry.name, Buffer.from([0]), entry.objectId]);
}

function sortName(entry: HashedEntry): Buffer {
  return entry.mode === "40000" ? Buffer.concat([entry.name, Buffer.from("/")]) : entry.name;
}

function hashObject(format: GitObjectFormat, type: "blob" | "tree", bytes: Buffer): Buffer {
  return createHash(format).update(`${type} ${bytes.length}\0`).update(bytes).digest();
}

function objectFormatOf(value: string): GitObjectFormat | undefined {
  if (/^[0-9a-f]{40}$/.test(value)) return "sha1";
  if (/^[0-9a-f]{64}$/.test(value)) return "sha256";
  return undefined;
}

function invalidTree(): never {
  throw new NativeProjectRootSnapshotTreeHashError("native root snapshot tree identity is invalid");
}

export class NativeProjectRootSnapshotTreeHashError extends Error {
  readonly name = "NativeProjectRootSnapshotTreeHashError";
}
