import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { assertGitExecutableIdentity, isNativeGitOrdinaryCandidateRef, nativeRepositoryBranches, resolveAuthoritativeNativeRepositoryTarget, type RepositoryExtensionContext } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { codeReviewService } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";

const execute = promisify(execFile);
export type PreparedBranchMerge = {
  readonly schemaVersion: 1; readonly outcome: "proposed" | "unchanged" | "conflict";
  readonly sourceRef: string; readonly targetRef: string; readonly sourceCommit: string; readonly expectedProtectedHead: string;
  readonly proposalRef?: string; readonly candidateCommit?: string; readonly reviewId?: string;
};
/** The caller holds repository serialization; no protected ref is advanced here. */
export async function prepareBranchMerge(context: RepositoryExtensionContext,
  selector: { readonly projectId: string; readonly repositoryId: string; readonly sourceRef: string; readonly targetRef: string }): Promise<PreparedBranchMerge> {
  if (selector.sourceRef === selector.targetRef) throw new Error("merge source and target branches must differ");
  const target = await resolveAuthoritativeNativeRepositoryTarget(context.runtime, { projectId: selector.projectId, repositoryId: selector.repositoryId, protectedRef: selector.targetRef });
  if (!selector.sourceRef.startsWith("refs/heads/") || !isNativeGitOrdinaryCandidateRef(selector.sourceRef)) throw new Error("merge source must be an ordinary branch ref");
  const expectedProtectedHead = target.currentHead.commit;
  const git = async (args: readonly string[], conflict = false) => {
    await assertGitExecutableIdentity(context.runtime.gitExecutable, context.runtime.gitIdentity);
    try {
      const result = await execute(context.runtime.gitExecutable, ["--no-replace-objects", "--git-dir", target.repository,
        "-c", "core.hooksPath=/dev/null", ...args], { signal: context.signal, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
        env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", HOME: "/dev/null", LC_ALL: "C",
          GIT_AUTHOR_NAME: "DIM branch merge", GIT_AUTHOR_EMAIL: "merge@dim.invalid", GIT_COMMITTER_NAME: "DIM branch merge", GIT_COMMITTER_EMAIL: "merge@dim.invalid" } });
      await assertGitExecutableIdentity(context.runtime.gitExecutable, context.runtime.gitIdentity);
      return { output: result.stdout, conflict: false };
    } catch (error) {
      if (conflict && error instanceof Error && "code" in error && error.code === 1 && "stdout" in error && typeof error.stdout === "string") return { output: error.stdout, conflict: true };
      throw new Error("branch merge could not be prepared");
    }
  };
  let sourceCommit: string;
  if (Object.hasOwn(nativeRepositoryBranches(target.imported.policy), selector.sourceRef)) {
    const source = await resolveAuthoritativeNativeRepositoryTarget(context.runtime, { projectId: selector.projectId, repositoryId: selector.repositoryId, protectedRef: selector.sourceRef });
    sourceCommit = source.currentHead.commit;
  } else {
    if (!(await git(["symbolic-ref", "--quiet", selector.sourceRef], true)).conflict) throw new Error("merge source must be a direct branch ref");
    sourceCommit = objectId((await git(["show-ref", "--verify", "--hash", selector.sourceRef])).output);
    if ((await git(["cat-file", "-t", sourceCommit])).output.trim() !== "commit") throw new Error("merge source must point to a commit");
  }
  const evidence = { schemaVersion: 1 as const, sourceRef: selector.sourceRef, targetRef: selector.targetRef, sourceCommit, expectedProtectedHead };
  if (!(await git(["merge-base", "--is-ancestor", sourceCommit, expectedProtectedHead], true)).conflict) return { ...evidence, outcome: "unchanged" };
  let candidateCommit = sourceCommit;
  if ((await git(["merge-base", "--is-ancestor", expectedProtectedHead, sourceCommit], true)).conflict) {
    const merged = await git(["merge-tree", "--write-tree", expectedProtectedHead, sourceCommit], true);
    if (merged.conflict) return { ...evidence, outcome: "conflict" };
    const tree = objectId(merged.output.split("\n")[0] ?? "");
    candidateCommit = objectId((await git(["commit-tree", tree, "-p", expectedProtectedHead, "-p", sourceCommit, "-m", `Merge ${selector.sourceRef} into ${selector.targetRef}`])).output);
  }
  const identity = createHash("sha256").update(`dim-branch-merge-v1\0${context.runtime.expectedGenerationId}\0${selector.projectId}\0${selector.repositoryId}`).digest("base64url");
  const branch = createHash("sha256").update(`${selector.sourceRef}\0${selector.targetRef}`).digest("hex").slice(0, 16);
  const proposalRef = `refs/heads/proposals/${identity}/merge/${branch}/${expectedProtectedHead}-${sourceCommit}`;
  const existing = await git(["rev-parse", "--verify", "--quiet", proposalRef], true);
  if (existing.conflict) await git(["update-ref", "--no-deref", proposalRef, candidateCommit, "0".repeat(candidateCommit.length)]);
  else candidateCommit = objectId(existing.output);
  const envelope = await codeReviewService(context.extensions).createInTransaction(context, {
    projectId: selector.projectId, repositoryId: selector.repositoryId, proposalRef, protectedRef: selector.targetRef
  });
  return { ...evidence, outcome: "proposed", proposalRef, candidateCommit, reviewId: envelope.review.reviewId };
}
function objectId(input: string): string {
  const value = input.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error("branch merge returned an invalid object ID");
  return value;
}
