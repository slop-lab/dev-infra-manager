import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { repositoryPolicyRevision } from "../../../packages/gs/repository-contracts/src/index.js";
import { assertGitVersion, initializeRepository } from "../../../packages/gs/repository/src/index.js";
import { openRepositoryAuthority } from "../../../packages/gs/repository-service/src/index.js";
import {
  createGitRepositoryReadService,
  createReviewFeature,
  defaultReviewChangeMatchers,
} from "../../../packages/gs/review/src/index.js";
import { openMergePolicyFeature } from "../../../packages/gs/merge-policy/src/index.js";

class StandaloneDriverError extends Error {
  readonly name = "StandaloneDriverError";
}

const root = process.argv[2];
if (root === undefined) throw new StandaloneDriverError("standalone root is required");

const execute = promisify(execFile);
const storageRoot = join(root, "storage");
const source = join(root, "source");
const selector = { namespaceId: "tenant", repositoryId: "main" } as const;
const repositoryPath = join(storageRoot, selector.namespaceId, `${selector.repositoryId}.git`);
const statePath = join(root, "repository-authority.sqlite3");
const mergeStatePath = join(root, "merge-authorizations.sqlite3");
const proposalRef = "refs/heads/review-candidate";

await mkdir(join(storageRoot, selector.namespaceId), { recursive: true });
await git(["init", source]);
await git(["-C", source, "config", "user.name", "GS Review Driver"]);
await git(["-C", source, "config", "user.email", "review@example.invalid"]);
await writeFile(join(source, "README.md"), "initial\n");
await git(["-C", source, "add", "README.md"]);
await git(["-C", source, "commit", "-m", "initial"]);
const initialCommit = await git(["-C", source, "rev-parse", "HEAD"]);
const initialTree = await git(["-C", source, "rev-parse", "HEAD^{tree}"]);
const gitVersion = (await git(["--version"])).replace(/^git version /, "");
const repositoryRuntime = { gitExecutable: "/usr/bin/git", gitVersion, storageRoot };
await initializeRepository(repositoryRuntime, selector);
await git(["--git-dir", repositoryPath, "fetch", source, "HEAD:refs/heads/main"]);
await writeFile(join(source, "README.md"), "candidate\n");
await git(["-C", source, "commit", "-am", "candidate"]);
const candidateCommit = await git(["-C", source, "rev-parse", "HEAD"]);
const candidateTree = await git(["-C", source, "rev-parse", "HEAD^{tree}"]);
await git(["--git-dir", repositoryPath, "fetch", source, `HEAD:${proposalRef}`]);
const gitIdentity = await assertGitVersion(repositoryRuntime);

const policyBase = {
  schemaVersion: 1 as const,
  protectedRef: "refs/heads/main",
  extensions: {
    "code-review": { requiredReviewerIds: ["owner"], pathReviewerRules: [], changeReviewerRules: [] },
    "merge-policy": {},
    "required-quality": {},
  },
};
const policy = { ...policyBase, policyRevision: repositoryPolicyRevision(policyBase) };
const first = await startFeatures();
const registered = await first.authority.registerRepository({
  selector,
  ownerPrincipalId: "repository-owner",
  policy,
  branches: [{ protectedRef: "refs/heads/main", commit: initialCommit, tree: initialTree }],
});

const envelope = await first.review.create({ ...selector, proposalRef, requesterPrincipalId: "review-requester" });
const initialStatus = (await first.review.inspect({ ...selector, reviewId: envelope.review.reviewId })).status;
const approval = await first.review.approve({ ...selector, reviewId: envelope.review.reviewId,
  reviewerId: "owner", requestId: "00000000-0000-4000-8000-000000000001" });
const approvedStatus = (await first.review.inspect({ ...selector, reviewId: envelope.review.reviewId })).status;
await first.review.revoke({ ...selector, reviewId: envelope.review.reviewId,
  reviewerId: "owner", approvalId: approval.approval.approvalId });
const revokedStatus = (await first.review.inspect({ ...selector, reviewId: envelope.review.reviewId })).status;
await first.review.approve({ ...selector, reviewId: envelope.review.reviewId,
  reviewerId: "owner", requestId: "00000000-0000-4000-8000-000000000002" });
let providerFailureClosed = false;
const missingQuality = openMergePolicyFeature({
  statePath: join(root, "missing-quality.sqlite3"),
  reviewFeature: first.reviewFeature,
  reader: first.reader,
  qualityGuards: [],
  selectedRefPolicyNames: ["code-review", "merge-policy"],
  integrationPolicyNames: [],
});
const missingQualityService = missingQuality.attach({ authority: first.authority, mutationGate: first.authority });
try {
  await missingQualityService.promote({ ...selector, reviewId: envelope.review.reviewId });
} catch (error) {
  if (!(error instanceof Error)) throw error;
  providerFailureClosed = /required merge quality guard/i.test(error.message);
} finally {
  await missingQualityService.close();
}
let crashObserved = false;
try {
  await first.authority.mutate(selector, (access) => first.mergeFeature.promoteInTransaction(
    access,
    { ...selector, reviewId: envelope.review.reviewId },
    { afterCompareAndSwap() { throw new StandaloneDriverError("simulated post-CAS interruption"); } },
  ));
} catch (error) {
  if (!(error instanceof StandaloneDriverError)) throw error;
  crashObserved = true;
}
const protectedHead = await git(["--git-dir", repositoryPath, "rev-parse", "refs/heads/main"]);
const persistedPathsPreserved = await pathsExist([
  join(repositoryPath, "dim-authoritative-reviews", "proposals"),
  join(repositoryPath, "dim-authoritative-approvals", "records"),
  join(repositoryPath, "dim-authoritative-revocations", "records"),
]);
await first.merge.close();
await first.authority.close();

const restarted = await startFeatures();
const current = await restarted.authority.resolve(selector);
const recoveredAuthorization = restarted.mergeFeature.authorizationStore.read()
  .find((entry) => entry.authorization.reviewId === envelope.review.reviewId);
const promoted = await restarted.merge.promote({ ...selector, reviewId: envelope.review.reviewId });
const restartedStatus = (await restarted.review.inspect({ ...selector, reviewId: envelope.review.reviewId })).status;
await restarted.merge.close();
await restarted.authority.close();

console.log(JSON.stringify({
  initialCommit,
  candidateCommit,
  protectedHead,
  initialStatus,
  approvedStatus,
  revokedStatus,
  promoted,
  crashObserved,
  recoveredSequence: recoveredAuthorization?.sequence,
  restartedStatus,
  providerFailureClosed,
  persistedPathsPreserved,
  epochAdvanced: registered.authorityEpoch !== current.authorityEpoch,
}));

async function startFeatures() {
  let authorityEpoch = "";
  const reader = createGitRepositoryReadService({ runtime: repositoryRuntime, gitIdentity });
  const reviewFeature = createReviewFeature({
    reader,
    matchers: defaultReviewChangeMatchers(),
    preparations: [],
    currentAuthorityEpoch: () => authorityEpoch,
  });
  const mergeFeature = openMergePolicyFeature({
    statePath: mergeStatePath,
    reviewFeature,
    reader,
    qualityGuards: [{
      name: "required-quality",
      revision: "d".repeat(64),
      async check(input) {
        return [{ kind: "required-quality", id: input.reviewId, digest: "e".repeat(64) }];
      },
    }],
    selectedRefPolicyNames: ["code-review", "merge-policy"],
    integrationPolicyNames: [],
  });
  const authority = await openRepositoryAuthority({
    statePath,
    runtime: repositoryRuntime,
    gitIdentity,
    refUpdatePolicies: [reviewFeature.refUpdatePolicy, mergeFeature.refUpdatePolicy],
    policySectionOwners: [
      reviewFeature.policySectionOwner,
      mergeFeature.policySectionOwner,
      {
        sectionName: "required-quality",
        enforcement: "configuration",
        parse: (value: unknown) => z.object({}).strict().readonly().parse(value),
      },
    ],
  });
  authorityEpoch = authority.authorityEpoch;
  await mergeFeature.recover(authority);
  const review = reviewFeature.attach({ authority, readGate: authority, mutationGate: authority });
  const merge = mergeFeature.attach({ authority, mutationGate: authority });
  return { authority, review, merge, reader, reviewFeature, mergeFeature };
}

async function pathsExist(paths: readonly string[]): Promise<boolean> {
  try {
    await Promise.all(paths.map((path) => access(path)));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function git(arguments_: readonly string[]): Promise<string> {
  return (await execute("/usr/bin/git", arguments_, {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  })).stdout.trim();
}
