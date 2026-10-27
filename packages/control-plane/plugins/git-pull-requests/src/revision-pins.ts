import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { gitBytes, type RepositoryExtensionContext, type RepositoryOwnedRef } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { currentRevision, type PullRequest, type PullRequestRevision } from "@slop-lab/gs-pull-requests";
import { PullRequestStore } from "./store.js";
export function revisionRef(requestId: string, revisionId: string, side: "base" | "head"): string { return `refs/dim/extensions/git-pull-requests/${requestId}/revisions/${revisionId}/${side}`; }
export async function ownedRevisionRefs(directory: string, selector: { projectId: string; repositoryId: string }): Promise<readonly RepositoryOwnedRef[]> {
  // Startup discovery reads only existing, private directories; it does not create state.
  for (const path of [directory, join(directory, selector.projectId), join(directory, selector.projectId, selector.repositoryId)]) {
    let info;
    try { info = await lstat(path); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Pull request pin ownership directory is invalid");
  }
  const records = await new PullRequestStore(directory).list(selector.projectId, selector.repositoryId);
  return records.flatMap((record) => record.revisions.flatMap((revision) => [
    { ref: revisionRef(record.id, revision.id, "base"), commit: revision.targetCommit },
    { ref: revisionRef(record.id, revision.id, "head"), commit: revision.sourceCommit }
  ]));
}
export async function pinRevision(context: RepositoryExtensionContext, repository: string, record: PullRequest, revision: PullRequestRevision = currentRevision(record)): Promise<void> {
  for (const [side, commit] of [["base", revision.targetCommit], ["head", revision.sourceCommit]] as const) {
    const ref = revisionRef(record.id, revision.id, side);
    const git = { ...context.runtime, repository, signal: context.signal };
    const existing = (await gitBytes(git, ["for-each-ref", "--format=%(objectname)", ref])).toString("ascii").trim();
    if (existing === commit) continue;
    if (existing !== "") throw new Error("Pull request pin conflicts with its durable record");
    await gitBytes(git, ["-c", "core.fsync=all", "update-ref", ref, commit, "0".repeat(commit.length)]);
  }
}
