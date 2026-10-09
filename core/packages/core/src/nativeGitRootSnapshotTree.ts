import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  readVerifiedCommit
} from "./nativeGitCandidateObjects.js";
import { rawObjectIdLength, readVerifiedBlobObject, readVerifiedTreeBytes } from "./nativeGitObjectBytes.js";
import { openDisposableGit, type DisposableGit, type GitObjectFormat } from "./nativeGitCandidateProcess.js";

export const nativeRootSnapshotTreeLimits = {
  processTimeoutMilliseconds: 30_000,
  maximumBlobBytes: 16 * 1024 * 1024,
  maximumMaterializedBytes: 256 * 1024 * 1024,
  maximumTreeBytes: 16 * 1024 * 1024,
  maximumEntries: 100_000,
  maximumDepth: 64,
  maximumLinkBytes: 4096
} as const;
const limits = nativeRootSnapshotTreeLimits;
const reservedLinks = new Set([
  ".dim", ".dim/setup.sh", ".dim/entrypoint.sh", ".dim/teardown.sh", ".dim/docker-compose.yml"
]);

type RootEntry = {
  readonly mode: "40000" | "100644" | "100755" | "120000";
  readonly path: string;
  readonly objectId: string;
};

type ReadState = {
  entries: number;
  bytes: number;
  treeBytes: number;
};

export type NativeRootSnapshotGitInput = {
  readonly gitExecutable: string;
  readonly temporaryRoot: string;
  readonly serviceEndpoint: string;
  readonly projectId: string;
  readonly protectedRef: string;
  readonly currentHeadCommit: string;
  readonly commit: string;
  readonly tree: string;
  readonly username: string;
  readonly password: string;
  readonly destination: string;
  readonly signal: AbortSignal;
};

export async function materializeNativeRootSnapshotTree(input: NativeRootSnapshotGitInput): Promise<void> {
  const objectFormat = objectFormatOf(input.commit);
  if (objectFormat === undefined || objectFormatOf(input.tree) !== objectFormat) {
    throw new NativeRootSnapshotTreeError("native root snapshot object identities are invalid");
  }
  const git = await openDisposableGit({ executable: input.gitExecutable, temporaryRoot: input.temporaryRoot,
    objectFormat, username: input.username, password: input.password,
    timeoutMilliseconds: limits.processTimeoutMilliseconds }, input.signal);
  try {
    const repositoryUrl = `${input.serviceEndpoint}/v1/projects/${input.projectId}/repositories/root.git`;
    await assertRemoteRef(git, repositoryUrl, input.protectedRef, input.currentHeadCommit, input.signal);
    await git.runAuthenticated(["--git-dir", git.repository, "fetch", "--depth=1", "--no-tags",
      "--no-write-fetch-head", repositoryUrl, `${input.commit}:refs/dim/root`],
    64 * 1024, input.signal);
    await git.run(["--git-dir", git.repository, "fsck", "--strict", "--full", "--no-reflogs",
      "--no-progress"], 64 * 1024, input.signal);
    const fetched = (await git.run(["--git-dir", git.repository, "rev-parse", "--verify",
      "refs/dim/root^{commit}"], 128, input.signal)).toString("ascii").trim();
    if (fetched !== input.commit) throw new NativeRootSnapshotTreeError("native Git returned a different root commit");
    const commit = await readVerifiedCommit(git, input.commit, input.signal);
    if (commit.treeObjectId !== input.tree) {
      throw new NativeRootSnapshotTreeError("native root commit tree conflicts with the draft");
    }
    const state: ReadState = { entries: 0, bytes: 0, treeBytes: 0 };
    const entries = await readRootEntries(git, input.tree, "", 0, state, input.signal);
    await writeRootEntries(git, input.destination, entries, state, input.signal);
    await assertRemoteRef(git, repositoryUrl, input.protectedRef, input.currentHeadCommit, input.signal);
  } finally {
    await git.close();
  }
}

async function assertRemoteRef(git: DisposableGit, url: string, ref: string, commit: string,
  signal: AbortSignal): Promise<void> {
  const output = (await git.runAuthenticated(["ls-remote", "--refs", url, ref], 4096, signal)).toString("ascii");
  if (output !== `${commit}\t${ref}\n`) throw new NativeRootSnapshotTreeError("native root protected ref changed");
}

async function readRootEntries(git: DisposableGit, tree: string, parent: string, depth: number,
  state: ReadState, signal: AbortSignal): Promise<readonly RootEntry[]> {
  if (depth > limits.maximumDepth) throw new NativeRootSnapshotTreeError("native root tree exceeds its depth limit");
  const bytes = await readVerifiedTreeBytes({ git, objectId: tree, maximumBytes: limits.maximumTreeBytes, signal });
  state.treeBytes += bytes.length;
  if (state.treeBytes > limits.maximumTreeBytes) {
    throw new NativeRootSnapshotTreeError("native root tree metadata exceeds its byte limit");
  }
  const rawLength = rawObjectIdLength(git.objectFormat);
  const entries: RootEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : bytes.indexOf(0, space + 1);
    const next = nul + 1 + rawLength;
    if (space < 0 || nul < 0 || next > bytes.length) {
      throw new NativeRootSnapshotTreeError("native root tree encoding is invalid");
    }
    const mode = rootMode(bytes.subarray(offset, space).toString("ascii"));
    const name = decodeName(bytes.subarray(space + 1, nul));
    if (names.has(name)) throw new NativeRootSnapshotTreeError("native root tree contains duplicate names");
    names.add(name);
    state.entries += 1;
    if (state.entries > limits.maximumEntries) {
      throw new NativeRootSnapshotTreeError("native root tree exceeds its entry limit");
    }
    const entry = { mode, path: parent === "" ? name : `${parent}/${name}`,
      objectId: bytes.subarray(nul + 1, next).toString("hex") } satisfies RootEntry;
    entries.push(entry);
    if (mode === "40000") {
      entries.push(...await readRootEntries(git, entry.objectId, entry.path, depth + 1, state, signal));
    }
    offset = next;
  }
  return entries;
}

async function writeRootEntries(git: DisposableGit, root: string, entries: readonly RootEntry[],
  state: ReadState, signal: AbortSignal): Promise<void> {
  for (const entry of entries) {
    const target = join(root, entry.path);
    if (entry.mode === "40000") await mkdir(target, { mode: 0o700 });
    else if (entry.mode !== "120000") {
      const remaining = Math.min(limits.maximumBlobBytes, limits.maximumMaterializedBytes - state.bytes);
      if (remaining < 0) throw new NativeRootSnapshotTreeError("native root tree exceeds its byte limit");
      const bytes = await readVerifiedBlobObject({ git, objectId: entry.objectId, maximumBytes: remaining, signal });
      state.bytes += bytes.length;
      await writeFile(target, bytes, { flag: "wx", mode: entry.mode === "100755" ? 0o700 : 0o600 });
    }
  }
  const links: string[] = [];
  for (const entry of entries) {
    if (entry.mode !== "120000") continue;
    if (reservedLinks.has(entry.path)) {
      throw new NativeRootSnapshotTreeError("native root tree has a symbolic link at a reserved lifecycle path");
    }
    const bytes = await readVerifiedBlobObject({ git, objectId: entry.objectId,
      maximumBytes: limits.maximumLinkBytes, signal });
    state.bytes += bytes.length;
    if (state.bytes > limits.maximumMaterializedBytes) {
      throw new NativeRootSnapshotTreeError("native root tree exceeds its byte limit");
    }
    const link = decodeLink(bytes);
    const resolved = resolve(root, dirname(entry.path), link);
    if (isAbsolute(link) || (resolved !== root && !resolved.startsWith(`${root}${sep}`))) {
      throw new NativeRootSnapshotTreeError("native root tree contains an escaping symbolic link");
    }
    await symlink(link, join(root, entry.path));
    links.push(entry.path);
  }
  for (const link of links) {
    const resolved = await realpath(join(root, link)).catch(() => undefined);
    if (resolved === undefined || (resolved !== root && !resolved.startsWith(`${root}${sep}`))) {
      throw new NativeRootSnapshotTreeError("native root tree contains a dangling or escaping symbolic link");
    }
  }
}

function rootMode(value: string): RootEntry["mode"] {
  if (value === "40000" || value === "100644" || value === "100755" || value === "120000") return value;
  throw new NativeRootSnapshotTreeError("native root tree contains an unsafe entry mode");
}

function decodeName(bytes: Buffer): string {
  const name = decodeUtf8(bytes, "native root tree name is not UTF-8");
  if (name.length === 0 || name === "." || name === ".." || name === ".git"
    || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new NativeRootSnapshotTreeError("native root tree name is unsafe");
  }
  return name;
}

function decodeLink(bytes: Buffer): string {
  const value = decodeUtf8(bytes, "native root symbolic link target is not UTF-8");
  if (value.length === 0 || value.includes("\0")) {
    throw new NativeRootSnapshotTreeError("native root symbolic link target is invalid");
  }
  return value;
}

function decodeUtf8(bytes: Buffer, message: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw new NativeRootSnapshotTreeError(message, { cause: error });
    throw error;
  }
}

function objectFormatOf(value: string): GitObjectFormat | undefined {
  if (/^[0-9a-f]{40}$/.test(value)) return "sha1";
  if (/^[0-9a-f]{64}$/.test(value)) return "sha256";
  return undefined;
}

export class NativeRootSnapshotTreeError extends Error {
  readonly name = "NativeRootSnapshotTreeError";
}
