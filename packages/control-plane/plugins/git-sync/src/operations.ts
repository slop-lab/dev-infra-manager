import { createHash, randomUUID } from "node:crypto";
import { resolveAuthoritativeNativeRepositoryTarget, type RepositoryExtensionContext } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { parseGitSyncPolicy, type GitSyncConfiguration } from "./config.js";
import { GitSyncOperationError, gitRunner } from "./git.js";

export type GitSyncOperation = "fetch" | "merge" | "publish";
export async function synchronizeRepository(context: RepositoryExtensionContext, config: GitSyncConfiguration,
  selector: { readonly projectId: string; readonly repositoryId: string }, operation: GitSyncOperation) {
  const target = await resolveAuthoritativeNativeRepositoryTarget(context.runtime, selector);
  const policy = parseGitSyncPolicy(target.imported.policy.extensions["git-sync"], config.allowLocalRemotes);
  const git = gitRunner(context.runtime, target.repository, config, context.signal, policy.upstream.url);
  const expectedProtectedHead = target.currentHead.commit;
  if (operation === "publish") {
    const managedBranch = target.currentHead.protectedRef.slice("refs/heads/".length);
    const destination = Object.hasOwn(policy.publish, managedBranch) ? policy.publish[managedBranch] : undefined;
    if (destination === undefined) throw new Error("protected branch has no reviewed publish destination");
    const targetRef = `refs/heads/${destination}`;
    await git(["push", "--porcelain", "--no-verify", policy.upstream.url, `${expectedProtectedHead}:${targetRef}`], { remote: true });
    return { schemaVersion: 1 as const, outcome: "published" as const, sourceCommit: expectedProtectedHead, targetRef };
  }
  const upstreamRef = `refs/remotes/upstream/${policy.upstream.branch}`;
  // Fetch into a private temporary ref first: remote-tracking refs otherwise accept upstream rewrites.
  const temporaryRef = `refs/remotes/upstream/dim-fetch-${randomUUID()}`;
  let upstreamCommit: string;
  try {
    await git(["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", policy.upstream.url,
      `refs/heads/${policy.upstream.branch}:${temporaryRef}`], { remote: true });
    upstreamCommit = objectId((await git(["rev-parse", "--verify", `${temporaryRef}^{commit}`])).output);
    const previous = await git(["rev-parse", "--verify", "--quiet", upstreamRef], { conflict: true });
    const previousCommit = previous.conflict ? "0".repeat(upstreamCommit.length) : objectId(previous.output);
    if (!previous.conflict && (await git(["merge-base", "--is-ancestor", previousCommit, upstreamCommit], { conflict: true })).conflict) {
      throw new GitSyncOperationError("upstream branch was rewritten; resolve the tracking ref through trusted operator administration");
    }
    await git(["update-ref", "--no-deref", upstreamRef, upstreamCommit, previousCommit]);
  } finally { await git(["update-ref", "--no-deref", "-d", temporaryRef]); }
  if (operation === "fetch") return { schemaVersion: 1 as const, outcome: "fetched" as const, upstreamRef, upstreamCommit, expectedProtectedHead };
  const ancestor = await git(["merge-base", "--is-ancestor", upstreamCommit, expectedProtectedHead], { conflict: true });
  if (!ancestor.conflict) return { schemaVersion: 1 as const, outcome: "unchanged" as const, upstreamRef, upstreamCommit, expectedProtectedHead };
  const fastForward = await git(["merge-base", "--is-ancestor", expectedProtectedHead, upstreamCommit], { conflict: true });
  let candidateCommit = upstreamCommit;
  if (fastForward.conflict) {
    const merged = await git(["merge-tree", "--write-tree", expectedProtectedHead, upstreamCommit], { conflict: true });
    if (merged.conflict) return { schemaVersion: 1 as const, outcome: "conflict" as const, upstreamRef, upstreamCommit, expectedProtectedHead };
    const tree = objectId(merged.output.split("\n")[0] ?? "");
    candidateCommit = objectId((await git(["commit-tree", tree, "-p", expectedProtectedHead, "-p", upstreamCommit,
      "-m", `Merge upstream/${policy.upstream.branch}`], { commit: true })).output);
  }
  // Dedicated non-workspace service identity; every update still enters the same proposal/review path.
  const identity = createHash("sha256").update(`dim-git-sync-v1\0${context.runtime.expectedGenerationId}\0${selector.projectId}\0${selector.repositoryId}`).digest("base64url");
  const branchIdentity = createHash("sha256").update(policy.upstream.branch).digest("hex").slice(0, 16);
  const proposalRef = `refs/heads/proposals/${identity}/upstream/${branchIdentity}/${expectedProtectedHead}-${upstreamCommit}`;
  const existing = await git(["rev-parse", "--verify", "--quiet", proposalRef], { conflict: true });
  if (existing.conflict) await git(["update-ref", "--no-deref", proposalRef, candidateCommit, "0".repeat(candidateCommit.length)]);
  else candidateCommit = objectId(existing.output);
  await context.reconcileProposals(selector.projectId, selector.repositoryId, [proposalRef]);
  return { schemaVersion: 1 as const, outcome: "proposed" as const, upstreamRef, upstreamCommit, expectedProtectedHead, proposalRef, candidateCommit };
}
function objectId(value: string): string {
  const result = value.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result)) throw new Error("Git synchronization returned an invalid object ID");
  return result;
}
