import type { RepositoryExtensionContext } from "./plugin-api.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { assertGitExecutableIdentity, type GitExecutableIdentity } from "./repository.js";
import { isOrdinaryCandidateRef as isNativeGitOrdinaryCandidateRef } from "@slop-lab/gs-repository-contracts";

const execute = promisify(execFile);
const maximumBytes = 4 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
export type RepositoryReadGit = {
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly repository: string;
  readonly signal: AbortSignal;
  readonly standardInput?: Buffer;
};
export class RepositoryReadError extends Error { readonly name = "RepositoryReadError"; }
export function assertCommit(commit: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new RepositoryReadError("repository reads require complete immutable commit IDs");
}
export async function gitBytes(input: RepositoryReadGit, args: readonly string[], limit = maximumBytes): Promise<Buffer> {
  await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
  const execution = execute(input.gitExecutable, ["--no-replace-objects", "--git-dir", input.repository,
    "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "diff.renames=false", ...args], {
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", HOME: "/dev/null", LC_ALL: "C" },
    encoding: "buffer", maxBuffer: limit, timeout: 15_000, signal: input.signal
  });
  if (input.standardInput !== undefined) {
    execution.child.stdin?.on("error", () => execution.child.kill());
    execution.child.stdin?.end(input.standardInput);
  }
  const { stdout } = await execution;
  await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
  return stdout;
}
export function utf8(bytes: Buffer): string {
  try { return decoder.decode(bytes); } catch { throw new RepositoryReadError("repository data contains non-UTF-8 text; use the repository's binary tooling"); }
}
/** Only history advertised through managed branches, proposals or trusted integration pins is readable. */
export async function assertAdvertisedCommits(input: RepositoryReadGit, commits: readonly string[], protectedRefs: readonly string[], advertisedRefs: readonly string[] = []): Promise<void> {
  commits.forEach(assertCommit);
  const objects = new Set<string>();
  for (const entry of utf8(await gitBytes(input, ["for-each-ref", "--format=%(refname)%09%(objectname)"])).trim().split("\n").filter(Boolean)) {
    const match = /^(refs\/[^\t]+)\t([0-9a-f]{40}|[0-9a-f]{64})$/.exec(entry);
    const ref = match?.[1], objectId = match?.[2];
    if (!ref || !objectId) throw new RepositoryReadError("repository ref identity is invalid");
    if (!protectedRefs.includes(ref) && !advertisedRefs.includes(ref)
      && !isNativeGitOrdinaryCandidateRef(ref) && !/^refs\/heads\/proposals\/[A-Za-z0-9_-]+\/.+/.test(ref)) continue;
    objects.add(objectId);
  }
  if (objects.size === 0) throw new RepositoryReadError("repository has no advertised commits");
  const records = utf8(await gitBytes({ ...input, standardInput: Buffer.from([...objects].map(objectId => `${objectId}^{}\n`).join("")) },
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"])).trim().split("\n");
  if (records.length !== objects.size) throw new RepositoryReadError("repository ref inspection is incomplete");
  const refs = new Set<string>();
  for (const record of records) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (commit|blob|tree)$/.exec(record);
    const objectId = match?.[1], type = match?.[2];
    if (!objectId || !type) throw new RepositoryReadError("repository ref object is invalid");
    if (type === "commit") refs.add(objectId);
  }
  if (refs.size === 0) throw new RepositoryReadError("repository has no advertised commits");
  for (const commit of commits) {
    const content = await gitBytes(input, ["cat-file", "commit", commit]);
    assertObjectIdentity(commit, "commit", content);
    let reachable = false;
    for (const ref of refs) {
      try { await gitBytes(input, ["merge-base", "--is-ancestor", commit, ref]); reachable = true; break; }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === 1)) throw error; }
    }
    if (!reachable) throw new RepositoryReadError("commit is outside advertised repository history");
  }
}
export type BlobMetadata = { readonly blobId: string; readonly lineCount: number | null; readonly byteLength: number; readonly mode: string };
export async function readTreeFile(input: RepositoryReadGit, commit: string, path: string): Promise<BlobMetadata | null> {
  assertCommit(commit);
  if (path.includes("\0") || path.length === 0) throw new RepositoryReadError("invalid file path");
  const entry = await selectedTreeEntry(input, commit, path);
  if (entry === undefined) return null;
  const blobId = entry.objectId;
  if (entry.mode === "160000") return { blobId, mode: entry.mode, byteLength: 0, lineCount: null };
  if (!["100644", "100755", "120000"].includes(entry.mode)) throw new RepositoryReadError("tree file is ambiguous");
  const content = await gitBytes(input, ["cat-file", "blob", blobId]);
  assertObjectIdentity(blobId, "blob", content);
  let lineCount: number | null = null;
  if (!content.includes(0)) {
    try {
      utf8(content);
      lineCount = content.length === 0 ? 0 : content.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0) + (content.at(-1) === 10 ? 0 : 1);
    } catch { /* Non-UTF8 blobs have no text anchors. */ }
  }
  return { blobId, mode: entry.mode, byteLength: content.length, lineCount };
}

type TreeEntry = { readonly mode: string; readonly objectId: string };

async function selectedTreeEntry(input: RepositoryReadGit, commit: string, path: string): Promise<TreeEntry | undefined> {
  const content = await gitBytes(input, ["cat-file", "commit", commit]);
  assertObjectIdentity(commit, "commit", content);
  const newline = content.indexOf(10);
  const root = newline < 0 ? null : /^tree ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(content.subarray(0, newline).toString("ascii"));
  let tree = root?.[1];
  if (tree === undefined || tree.length !== commit.length) throw new RepositoryReadError("repository commit tree identity is invalid");
  const parts = path.split("/");
  let remaining = maximumBytes;
  for (const [index, part] of parts.entries()) {
    if (remaining <= 0) throw new RepositoryReadError("selected path trees exceed the repository read bound");
    const bytes = await gitBytes(input, ["cat-file", "tree", tree], remaining);
    assertObjectIdentity(tree, "tree", bytes);
    remaining -= bytes.length;
    const entry = findTreeEntry(bytes, Buffer.from(part), commit.length / 2);
    if (entry === undefined || index < parts.length - 1 && entry.mode !== "40000") return undefined;
    if (index === parts.length - 1) return entry;
    tree = entry.objectId;
  }
  return undefined;
}

function findTreeEntry(content: Buffer, name: Buffer, objectBytes: number): TreeEntry | undefined {
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(32, offset), nul = space < 0 ? -1 : content.indexOf(0, space + 1);
    const end = nul + 1 + objectBytes;
    if (space <= offset || nul <= space + 1 || end > content.length) throw new RepositoryReadError("repository tree entry is malformed");
    if (content.subarray(space + 1, nul).equals(name)) {
      return { mode: content.subarray(offset, space).toString("ascii"), objectId: content.subarray(nul + 1, end).toString("hex") };
    }
    offset = end;
  }
  return undefined;
}

function assertObjectIdentity(objectId: string, type: "blob" | "commit" | "tree", content: Buffer): void {
  const algorithm = objectId.length === 40 ? "sha1" : objectId.length === 64 ? "sha256" : undefined;
  if (algorithm === undefined) throw new RepositoryReadError("repository object identity is invalid");
  const actual = createHash(algorithm)
    .update(`${type} ${String(content.length)}\0`)
    .update(content)
    .digest("hex");
  if (actual !== objectId) throw new RepositoryReadError(`repository ${type} identity is invalid`);
}

/** Repository integrations advertise only durable object pins owned by their exact repository. */
export type RepositoryReadHistoryProvider = {
  refs(context: RepositoryExtensionContext, selector: { readonly projectId: string; readonly repositoryId: string }): Promise<readonly string[]>;
};
export async function repositoryReadHistoryRefs(context: RepositoryExtensionContext, selector: { readonly projectId: string; readonly repositoryId: string }): Promise<readonly string[]> {
  const refs: string[] = [];
  for (const extension of context.extensions.filter((entry) => entry.kind === "dim.git-repositories.read-history")) {
    if (!("refs" in extension.value) || typeof extension.value.refs !== "function") throw new RepositoryReadError("repository history provider is invalid");
    const provider = extension.value as RepositoryReadHistoryProvider;
    for (const ref of await provider.refs(context, selector)) {
      if (!ref.startsWith("refs/") || ref.length > 4096 || /[\x00-\x20\x7f]/.test(ref)) throw new RepositoryReadError("repository history ref is invalid");
      refs.push(ref);
    }
  }
  if (refs.length > 10_000) throw new RepositoryReadError("repository history exceeds the read limit");
  return [...new Set(refs)];
}
