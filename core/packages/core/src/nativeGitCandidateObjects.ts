import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { NativeCandidateBlob } from "./nativeOrdinaryCandidateVerifier.js";
import {
  effectiveUserId,
  type DisposableGit,
  type GitObjectFormat
} from "./nativeGitCandidateProcess.js";

const objectFormatProperties = {
  sha1: { hexLength: 40, rawLength: 20, hashAlgorithm: "sha1" },
  sha256: { hexLength: 64, rawLength: 32, hashAlgorithm: "sha256" }
} as const satisfies Record<GitObjectFormat, {
  readonly hexLength: number;
  readonly rawLength: number;
  readonly hashAlgorithm: "sha1" | "sha256";
}>;

export type CandidateObjectLimits = {
  readonly maximumBlobBytes: number;
  readonly maximumMaterializedBytes: number;
  readonly maximumTreeBytes: number;
  readonly maximumEntries: number;
  readonly maximumDepth: number;
};

type TreeEntry = {
  readonly mode: "40000" | "100644" | "100755";
  readonly name: string;
  readonly objectId: string;
};

type MaterializeState = {
  entries: number;
  bytes: number;
  treeBytes: number;
};

type ObjectRead = {
  readonly git: DisposableGit;
  readonly objectId: string;
  readonly maximumBytes: number;
  readonly signal: AbortSignal;
};

type DirectoryMaterialization = {
  readonly git: DisposableGit;
  readonly treeObjectId: string;
  readonly destination: string;
  readonly depth: number;
  readonly state: MaterializeState;
  readonly limits: CandidateObjectLimits;
  readonly signal: AbortSignal;
};

export async function readVerifiedCommit(
  git: DisposableGit,
  objectId: string,
  signal: AbortSignal
): Promise<{ readonly objectId: string; readonly treeObjectId: string }> {
  const type = (await git.run(["--git-dir", git.repository, "cat-file", "-t", objectId], 64, signal)).toString("ascii").trim();
  if (type !== "commit") throw new CandidateObjectError("candidate object is not a commit");
  const bytes = await git.run(["--git-dir", git.repository, "cat-file", "commit", objectId], 1024 * 1024, signal);
  assertObjectId(git.objectFormat, "commit", bytes, objectId);
  const lineEnd = bytes.indexOf(0x0a);
  const objectIdLength = objectFormatProperties[git.objectFormat].hexLength;
  const match = lineEnd < 0 ? null : new RegExp(`^tree ([0-9a-f]{${objectIdLength}})$`)
    .exec(bytes.subarray(0, lineEnd).toString("ascii"));
  if (match?.[1] === undefined) throw new CandidateObjectError("candidate commit has no canonical tree header");
  return { objectId, treeObjectId: match[1] };
}

export async function readVerifiedBlob(input: {
  readonly git: DisposableGit;
  readonly treeObjectId: string;
  readonly path: string;
  readonly maximumBytes: number;
  readonly limits: CandidateObjectLimits;
  readonly signal: AbortSignal;
}): Promise<NativeCandidateBlob> {
  const components = candidatePath(input.path, input.limits.maximumDepth);
  let tree = input.treeObjectId;
  for (const [index, component] of components.entries()) {
    const listing = await readTree({
      git: input.git, objectId: tree, maximumBytes: input.limits.maximumTreeBytes, signal: input.signal
    });
    const entry = listing.entries.find((candidate) => candidate.name === component);
    if (entry === undefined) throw new CandidateObjectError("candidate blob path is absent");
    if (index < components.length - 1) {
      if (entry.mode !== "40000") throw new CandidateObjectError("candidate blob path has a non-tree ancestor");
      tree = entry.objectId;
      continue;
    }
    if (entry.mode === "40000") throw new CandidateObjectError("candidate blob path is not a regular file");
    const bytes = await readBlob({
      git: input.git, objectId: entry.objectId,
      maximumBytes: Math.min(input.maximumBytes, input.limits.maximumBlobBytes), signal: input.signal
    });
    return { objectId: entry.objectId, mode: entry.mode, bytes };
  }
  throw new CandidateObjectError("candidate blob path is invalid");
}

export async function materializeVerifiedTree(input: {
  readonly git: DisposableGit;
  readonly treeObjectId: string;
  readonly destination: string;
  readonly limits: CandidateObjectLimits;
  readonly signal: AbortSignal;
}): Promise<void> {
  const destination = resolve(input.destination);
  if (destination !== input.destination) throw new CandidateObjectError("candidate destination must be absolute and normalized");
  const parent = dirname(destination);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()
    || parentMetadata.uid !== effectiveUserId() || (parentMetadata.mode & 0o077) !== 0
    || await realpath(parent) !== parent) {
    throw new CandidateObjectError("candidate destination parent is not private");
  }
  await assertAbsent(destination);
  const staging = await mkdtemp(join(parent, `.${basename(destination)}.dim-stage-`));
  try {
    const state: MaterializeState = { entries: 0, bytes: 0, treeBytes: 0 };
    await materializeDirectory({
      git: input.git, treeObjectId: input.treeObjectId, destination: staging, depth: 0,
      state, limits: input.limits, signal: input.signal
    });
    await assertAbsent(destination);
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function materializeDirectory(input: DirectoryMaterialization): Promise<void> {
  if (input.depth > input.limits.maximumDepth) throw new CandidateObjectError("candidate tree exceeds its depth limit");
  const tree = await readTree({
    git: input.git, objectId: input.treeObjectId,
    maximumBytes: input.limits.maximumTreeBytes, signal: input.signal
  });
  input.state.treeBytes += tree.byteLength;
  if (input.state.treeBytes > input.limits.maximumTreeBytes) throw new CandidateObjectError("candidate tree metadata exceeds its byte limit");
  const entries = tree.entries;
  for (const entry of entries) {
    input.state.entries += 1;
    if (input.state.entries > input.limits.maximumEntries) throw new CandidateObjectError("candidate tree exceeds its entry limit");
    const path = join(input.destination, entry.name);
    if (entry.mode === "40000") {
      await mkdir(path, { mode: 0o755 });
      await materializeDirectory({ ...input, treeObjectId: entry.objectId, destination: path, depth: input.depth + 1 });
      continue;
    }
    const remaining = Math.min(
      input.limits.maximumBlobBytes,
      input.limits.maximumMaterializedBytes - input.state.bytes
    );
    if (remaining < 0) throw new CandidateObjectError("candidate tree exceeds its byte limit");
    const bytes = await readBlob({ git: input.git, objectId: entry.objectId, maximumBytes: remaining, signal: input.signal });
    input.state.bytes += bytes.length;
    await writeFile(path, bytes, { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 });
    await chmod(path, entry.mode === "100755" ? 0o755 : 0o644);
  }
}

async function readTree(input: ObjectRead): Promise<{ readonly entries: readonly TreeEntry[]; readonly byteLength: number }> {
  const bytes = await input.git.run([
    "--git-dir", input.git.repository, "cat-file", "tree", input.objectId
  ], input.maximumBytes, input.signal);
  assertObjectId(input.git.objectFormat, "tree", bytes, input.objectId);
  const rawObjectIdLength = objectFormatProperties[input.git.objectFormat].rawLength;
  const entries: TreeEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : bytes.indexOf(0, space + 1);
    const nextOffset = nul + 1 + rawObjectIdLength;
    if (space < 0 || nul < 0 || nextOffset > bytes.length) throw new CandidateObjectError("candidate tree encoding is invalid");
    const mode = bytes.subarray(offset, space).toString("ascii");
    if (mode !== "40000" && mode !== "100644" && mode !== "100755") {
      throw new CandidateObjectError("candidate tree contains an unsafe entry mode");
    }
    const name = decodeName(bytes.subarray(space + 1, nul));
    if (names.has(name)) throw new CandidateObjectError("candidate tree contains duplicate names");
    names.add(name);
    entries.push({ mode, name, objectId: bytes.subarray(nul + 1, nextOffset).toString("hex") });
    offset = nextOffset;
  }
  return { entries, byteLength: bytes.length };
}

async function readBlob(input: ObjectRead): Promise<Buffer> {
  const sizeText = (await input.git.run([
    "--git-dir", input.git.repository, "cat-file", "-s", input.objectId
  ], 64, input.signal)).toString("ascii").trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(sizeText) || BigInt(sizeText) > BigInt(input.maximumBytes)) {
    throw new CandidateObjectError("candidate blob exceeds its byte limit");
  }
  const bytes = await input.git.run([
    "--git-dir", input.git.repository, "cat-file", "blob", input.objectId
  ], input.maximumBytes, input.signal);
  if (bytes.length !== Number(sizeText)) throw new CandidateObjectError("candidate blob size changed");
  assertObjectId(input.git.objectFormat, "blob", bytes, input.objectId);
  return bytes;
}

function assertObjectId(
  objectFormat: GitObjectFormat,
  type: "blob" | "commit" | "tree",
  bytes: Buffer,
  expected: string
): void {
  const digest = createHash(objectFormatProperties[objectFormat].hashAlgorithm)
    .update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
  if (digest !== expected) throw new CandidateObjectError(`candidate ${type} identity does not match its bytes`);
}

function candidatePath(path: string, maximumDepth: number): readonly string[] {
  const components = path.split("/");
  if (components.length === 0 || components.length > maximumDepth
    || components.some((component) => !safeName(component))) {
    throw new CandidateObjectError("candidate blob path is unsafe");
  }
  return components;
}

function decodeName(bytes: Buffer): string {
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw new CandidateObjectError("candidate tree name is not UTF-8", { cause: error });
    throw error;
  }
  if (!safeName(name)) throw new CandidateObjectError("candidate tree name is unsafe");
  return name;
}

function safeName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && name !== ".git"
    && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new CandidateObjectError("candidate destination already exists");
}

export class CandidateObjectError extends Error {
  readonly name = "CandidateObjectError";
}
