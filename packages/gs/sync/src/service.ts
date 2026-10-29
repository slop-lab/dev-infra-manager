import { createHash, randomUUID } from "node:crypto";
import type { RepositorySelector } from "@slop-lab/gs-repository-contracts";
import type {
  ProposalConsumer,
  RepositoryMutationGate,
  RepositoryTarget,
} from "@slop-lab/gs-repository-service";
import type { GitSyncTransport } from "./git.js";
import { GitSyncOperationError } from "./git.js";
import { parseGitSyncPolicy } from "./policy.js";

export interface RepositoryPrincipalScope {
  readonly principalId: string;
  authorize(target: RepositoryTarget): Promise<void>;
}

export type GitSyncOperation = "fetch" | "propose" | "publish";
export type GitSyncServiceOptions = {
  readonly mutationGate: RepositoryMutationGate;
  readonly proposalConsumer: ProposalConsumer;
  readonly git: GitSyncTransport;
  readonly currentAuthorityEpoch: () => string;
};
export type GitSyncRequest = RepositorySelector & {
  readonly principal: RepositoryPrincipalScope;
  readonly operation: GitSyncOperation;
  readonly protectedRef?: string;
  readonly signal?: AbortSignal;
};

export interface GitSyncService {
  synchronize(request: GitSyncRequest): Promise<GitSyncResult>;
}

export type GitSyncResult =
  | { readonly schemaVersion: 1; readonly outcome: "published"; readonly sourceCommit: string; readonly targetRef: string }
  | { readonly schemaVersion: 1; readonly outcome: "fetched" | "unchanged" | "conflict"; readonly upstreamRef: string; readonly upstreamCommit: string; readonly expectedProtectedHead: string }
  | { readonly schemaVersion: 1; readonly outcome: "proposed"; readonly upstreamRef: string; readonly upstreamCommit: string; readonly expectedProtectedHead: string; readonly proposalRef: string; readonly candidateCommit: string };

export function createSyncService(options: GitSyncServiceOptions): GitSyncService {
  return {
    synchronize(request) {
      return options.mutationGate.mutate(request, async (access) => {
        await request.principal.authorize(access.target);
        const result = await synchronize(options, access.target, request);
        await assertProtectedHead(options, access.target, request);
        await request.principal.authorize(access.target);
        return result;
      });
    },
  };
}

async function assertProtectedHead(options: GitSyncServiceOptions, target: RepositoryTarget, request: GitSyncRequest): Promise<void> {
  const policy = parseGitSyncPolicy(target.policy.extensions["git-sync"], options.git.allowLocalRemotes);
  const current = objectId((await options.git.run({
    target,
    args: ["rev-parse", "--verify", `${target.head.protectedRef}^{commit}`],
    remoteUrl: policy.upstream.url,
    signal: request.signal ?? AbortSignal.timeout(30_000),
  })).output);
  if (current !== target.head.commit) throw new GitSyncOperationError("protected branch changed during synchronization");
}

async function synchronize(options: GitSyncServiceOptions, target: RepositoryTarget, request: GitSyncRequest): Promise<GitSyncResult> {
  const policy = parseGitSyncPolicy(target.policy.extensions["git-sync"], options.git.allowLocalRemotes);
  const signal = request.signal ?? AbortSignal.timeout(60_000);
  const run = (args: readonly string[], runOptions: { readonly remote?: boolean; readonly conflict?: boolean; readonly commit?: boolean } = {}) =>
    options.git.run({ target, args, remoteUrl: policy.upstream.url, signal, ...runOptions });
  const expectedProtectedHead = target.head.commit;
  if (request.operation === "publish") {
    const managedBranch = target.head.protectedRef.slice("refs/heads/".length);
    const destination = Object.hasOwn(policy.publish, managedBranch) ? policy.publish[managedBranch] : undefined;
    if (destination === undefined) throw new GitSyncOperationError("protected branch has no reviewed publish destination");
    const targetRef = `refs/heads/${destination}`;
    await run(["push", "--porcelain", "--no-verify", policy.upstream.url, `${expectedProtectedHead}:${targetRef}`], { remote: true });
    return { schemaVersion: 1, outcome: "published", sourceCommit: expectedProtectedHead, targetRef };
  }
  const upstreamRef = `refs/remotes/upstream/${policy.upstream.branch}`;
  const temporaryRef = `refs/remotes/upstream/dim-fetch-${randomUUID()}`;
  let upstreamCommit: string;
  try {
    await run(["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", policy.upstream.url,
      `refs/heads/${policy.upstream.branch}:${temporaryRef}`], { remote: true });
    upstreamCommit = objectId((await run(["rev-parse", "--verify", `${temporaryRef}^{commit}`])).output);
    const previous = await run(["rev-parse", "--verify", "--quiet", upstreamRef], { conflict: true });
    const previousCommit = previous.conflict ? "0".repeat(upstreamCommit.length) : objectId(previous.output);
    if (!previous.conflict && (await run(["merge-base", "--is-ancestor", previousCommit, upstreamCommit], { conflict: true })).conflict) {
      throw new GitSyncOperationError("upstream branch was rewritten; resolve the tracking ref through trusted operator administration");
    }
    await run(["update-ref", "--no-deref", upstreamRef, upstreamCommit, previousCommit]);
  } finally {
    await run(["update-ref", "--no-deref", "-d", temporaryRef]);
  }
  if (request.operation === "fetch") return { schemaVersion: 1, outcome: "fetched", upstreamRef, upstreamCommit, expectedProtectedHead };
  if (!(await run(["merge-base", "--is-ancestor", upstreamCommit, expectedProtectedHead], { conflict: true })).conflict) {
    return { schemaVersion: 1, outcome: "unchanged", upstreamRef, upstreamCommit, expectedProtectedHead };
  }
  const fastForward = await run(["merge-base", "--is-ancestor", expectedProtectedHead, upstreamCommit], { conflict: true });
  let candidateCommit = upstreamCommit;
  if (fastForward.conflict) {
    const merged = await run(["merge-tree", "--write-tree", expectedProtectedHead, upstreamCommit], { conflict: true });
    if (merged.conflict) return { schemaVersion: 1, outcome: "conflict", upstreamRef, upstreamCommit, expectedProtectedHead };
    const tree = objectId(merged.output.split("\n")[0] ?? "");
    candidateCommit = objectId((await run(["commit-tree", tree, "-p", expectedProtectedHead, "-p", upstreamCommit,
      "-m", `Merge upstream/${policy.upstream.branch}`], { commit: true })).output);
  }
  const identity = createHash("sha256").update(`dim-git-sync-v1\0${options.currentAuthorityEpoch()}\0${request.namespaceId}\0${request.repositoryId}`).digest("base64url");
  const branchIdentity = createHash("sha256").update(policy.upstream.branch).digest("hex").slice(0, 16);
  const proposalRef = `refs/heads/proposals/${identity}/upstream/${branchIdentity}/${expectedProtectedHead}-${upstreamCommit}`;
  const existing = await run(["rev-parse", "--verify", "--quiet", proposalRef], { conflict: true });
  if (existing.conflict) await run(["update-ref", "--no-deref", proposalRef, candidateCommit, "0".repeat(candidateCommit.length)]);
  else candidateCommit = objectId(existing.output);
  await options.proposalConsumer.consume({ selector: request, refs: [proposalRef] });
  return { schemaVersion: 1, outcome: "proposed", upstreamRef, upstreamCommit, expectedProtectedHead, proposalRef, candidateCommit };
}

function objectId(value: string): string {
  const result = value.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result)) throw new GitSyncOperationError("Git synchronization returned an invalid object ID");
  return result;
}
