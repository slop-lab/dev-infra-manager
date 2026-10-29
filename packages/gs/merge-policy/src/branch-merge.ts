import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { assertGitExecutableIdentity, type GitExecutableIdentity } from "@slop-lab/gs-repository";
import { isOrdinaryCandidateRef, repositoryBranches } from "@slop-lab/gs-repository-contracts";
import type { BorrowedRepositoryMutationAccess } from "@slop-lab/gs-repository-service";
import type { ReviewService } from "@slop-lab/gs-review";

const execute = promisify(execFile);

export type PreparedBranchMerge = {
  readonly schemaVersion: 1;
  readonly outcome: "proposed" | "unchanged" | "conflict";
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly sourceCommit: string;
  readonly expectedProtectedHead: string;
  readonly proposalRef?: string;
  readonly candidateCommit?: string;
  readonly reviewId?: string;
};

export async function prepareBranchMerge(input: {
  readonly access: BorrowedRepositoryMutationAccess;
  readonly review: ReviewService;
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly signal: AbortSignal;
}): Promise<PreparedBranchMerge> {
  if (input.sourceRef === input.targetRef) throw new BranchMergeError("merge source and target branches must differ");
  if (input.access.target.head.protectedRef !== input.targetRef) {
    throw new BranchMergeError("borrowed target does not match the requested merge target");
  }
  if (!input.sourceRef.startsWith("refs/heads/") || !isOrdinaryCandidateRef(input.sourceRef)) {
    throw new BranchMergeError("merge source must be an ordinary branch ref");
  }
  const target = input.access.target;
  const expectedProtectedHead = target.head.commit;
  const runGit = async (args: readonly string[], conflict = false) => {
    await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
    try {
      const result = await execute(input.gitExecutable, [
        "--no-replace-objects",
        "--git-dir",
        target.repositoryPath,
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ], {
        signal: input.signal,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_TERMINAL_PROMPT: "0",
          HOME: "/dev/null",
          LC_ALL: "C",
          GIT_AUTHOR_NAME: "DIM branch merge",
          GIT_AUTHOR_EMAIL: "merge@dim.invalid",
          GIT_COMMITTER_NAME: "DIM branch merge",
          GIT_COMMITTER_EMAIL: "merge@dim.invalid",
        },
      });
      await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
      return { output: result.stdout, conflict: false };
    } catch (error) {
      if (conflict && error instanceof Error && "code" in error && error.code === 1
        && "stdout" in error && typeof error.stdout === "string") {
        return { output: error.stdout, conflict: true };
      }
      throw new BranchMergeError("branch merge could not be prepared", { cause: error });
    }
  };
  let sourceCommit: string;
  if (Object.hasOwn(repositoryBranches(target.policy), input.sourceRef)) {
    const source = await input.access.authority.resolve({ ...target.selector, protectedRef: input.sourceRef });
    sourceCommit = source.head.commit;
  } else {
    if (!(await runGit(["symbolic-ref", "--quiet", input.sourceRef], true)).conflict) {
      throw new BranchMergeError("merge source must be a direct branch ref");
    }
    sourceCommit = objectId((await runGit(["show-ref", "--verify", "--hash", input.sourceRef])).output);
    if ((await runGit(["cat-file", "-t", sourceCommit])).output.trim() !== "commit") {
      throw new BranchMergeError("merge source must point to a commit");
    }
  }
  const evidence = {
    schemaVersion: 1 as const,
    sourceRef: input.sourceRef,
    targetRef: input.targetRef,
    sourceCommit,
    expectedProtectedHead,
  };
  if (!(await runGit(["merge-base", "--is-ancestor", sourceCommit, expectedProtectedHead], true)).conflict) {
    return { ...evidence, outcome: "unchanged" };
  }
  let candidateCommit = sourceCommit;
  if ((await runGit(["merge-base", "--is-ancestor", expectedProtectedHead, sourceCommit], true)).conflict) {
    const merged = await runGit(["merge-tree", "--write-tree", expectedProtectedHead, sourceCommit], true);
    if (merged.conflict) return { ...evidence, outcome: "conflict" };
    const tree = objectId(merged.output.split("\n")[0] ?? "");
    candidateCommit = objectId((await runGit([
      "commit-tree", tree, "-p", expectedProtectedHead, "-p", sourceCommit,
      "-m", `Merge ${input.sourceRef} into ${input.targetRef}`,
    ])).output);
  }
  const identity = createHash("sha256").update(
    `dim-branch-merge-v1\0${input.access.authority.authorityEpoch}\0${target.selector.namespaceId}\0${target.selector.repositoryId}`,
  ).digest("base64url");
  const branch = createHash("sha256").update(`${input.sourceRef}\0${input.targetRef}`).digest("hex").slice(0, 16);
  const proposalRef = `refs/heads/proposals/${identity}/merge/${branch}/${expectedProtectedHead}-${sourceCommit}`;
  const existing = await runGit(["rev-parse", "--verify", "--quiet", proposalRef], true);
  if (existing.conflict) {
    await runGit(["update-ref", "--no-deref", proposalRef, candidateCommit, "0".repeat(candidateCommit.length)]);
  } else {
    candidateCommit = objectId(existing.output);
  }
  const reviewAccess: BorrowedRepositoryMutationAccess = {
    authority: input.access.authority,
    target: await input.access.authority.resolve({ ...target.selector, protectedRef: input.targetRef }),
  };
  const envelope = await input.review.createInTransaction(reviewAccess, {
    namespaceId: target.selector.namespaceId,
    repositoryId: target.selector.repositoryId,
    proposalRef,
    protectedRef: input.targetRef,
  });
  return { ...evidence, outcome: "proposed", proposalRef, candidateCommit, reviewId: envelope.review.reviewId };
}

function objectId(input: string): string {
  const value = input.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new BranchMergeError("branch merge returned an invalid object ID");
  }
  return value;
}

export class BranchMergeError extends Error {
  readonly name = "BranchMergeError";
}
