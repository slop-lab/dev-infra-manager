import type { RepositoryExtensionContext } from "./plugin-api.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertGitExecutableIdentity, type GitExecutableIdentity } from "./repository.js";
import { isNativeGitOrdinaryCandidateRef } from "@slop-lab/dim-contracts-git";

const execute = promisify(execFile);
const maximumBytes = 4 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
export type RepositoryReadGit = {
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly repository: string;
  readonly signal: AbortSignal;
};
export class RepositoryReadError extends Error { readonly name = "RepositoryReadError"; }
export function assertCommit(commit: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new RepositoryReadError("repository reads require complete immutable commit IDs");
}
export async function gitBytes(input: RepositoryReadGit, args: readonly string[], limit = maximumBytes): Promise<Buffer> {
  await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
  const { stdout } = await execute(input.gitExecutable, ["--no-replace-objects", "--git-dir", input.repository,
    "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "diff.renames=false", ...args], {
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", HOME: "/dev/null", LC_ALL: "C" },
    encoding: "buffer", maxBuffer: limit, timeout: 15_000, signal: input.signal
  });
  await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
  return stdout;
}
export function utf8(bytes: Buffer): string {
  try { return decoder.decode(bytes); } catch { throw new RepositoryReadError("repository data contains non-UTF-8 text; use the repository's binary tooling"); }
}
/** Only history advertised through managed branches, proposals or trusted integration pins is readable. */
export async function assertAdvertisedCommits(input: RepositoryReadGit, commits: readonly string[], protectedRefs: readonly string[], advertisedRefs: readonly string[] = []): Promise<void> {
  commits.forEach(assertCommit);
  const refs: string[] = [];
  for (const entry of utf8(await gitBytes(input, ["for-each-ref", "--format=%(refname)%09%(objectname)"])).trim().split("\n").filter(Boolean)) {
    const match = /^(refs\/[^\t]+)\t([0-9a-f]{40}|[0-9a-f]{64})$/.exec(entry);
    const ref = match?.[1], objectId = match?.[2];
    if (!ref || !objectId) throw new RepositoryReadError("repository ref identity is invalid");
    if (!protectedRefs.includes(ref) && !advertisedRefs.includes(ref)
      && !isNativeGitOrdinaryCandidateRef(ref) && !/^refs\/heads\/proposals\/[A-Za-z0-9_-]+\/.+/.test(ref)) continue;
    const type = utf8(await gitBytes(input, ["cat-file", "-t", `${objectId}^{}`])).trim();
    if (type === "commit") refs.push(objectId);
    else if (type !== "blob" && type !== "tree") throw new RepositoryReadError("repository ref object is invalid");
  }
  if (refs.length === 0) throw new RepositoryReadError("repository has no advertised commits");
  for (const commit of commits) {
    const type = utf8(await gitBytes(input, ["cat-file", "-t", commit])).trim();
    if (type !== "commit") throw new RepositoryReadError("diff identity is not a commit");
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
  const result = await gitBytes(input, ["ls-tree", "-z", "--full-tree", commit, "--", `:(literal)${path}`]);
  if (result.length === 0) return null;
  const tab = result.indexOf(9);
  const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(result.subarray(0, tab).toString("ascii"));
  if (!match || !result.subarray(tab + 1, -1).equals(Buffer.from(path))) throw new RepositoryReadError("tree file is ambiguous");
  const blobId = match[3]!;
  if (match[2] === "commit") return { blobId, mode: match[1]!, byteLength: 0, lineCount: null };
  const content = await gitBytes(input, ["cat-file", "blob", blobId]);
  let lineCount: number | null = null;
  if (!content.includes(0)) {
    try {
      utf8(content);
      lineCount = content.length === 0 ? 0 : content.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0) + (content.at(-1) === 10 ? 0 : 1);
    } catch { /* Non-UTF8 blobs have no text anchors. */ }
  }
  return { blobId, mode: match[1]!, byteLength: content.length, lineCount };
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
