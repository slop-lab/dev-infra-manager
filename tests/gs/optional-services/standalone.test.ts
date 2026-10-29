import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { repositoryPolicyRevision } from "../../../packages/gs/repository-contracts/src/index.js";
import { assertGitVersion, initializeRepository } from "../../../packages/gs/repository/src/index.js";
import { openRepositoryAuthority } from "../../../packages/gs/repository-service/src/index.js";
import { createGitRepositoryReadService } from "../../../packages/gs/repository-service/src/index.js";
import { createDiffService } from "../../../packages/gs/diff-service/src/index.js";
import { createBlameService } from "../../../packages/gs/blame-service/src/index.js";
import { openPullRequestService } from "../../../packages/gs/pull-request-service/src/index.js";
import { createDiscussionsService } from "../../../packages/gs/discussions-service/src/index.js";
import { createNodeGitSyncTransport, createSyncService, gitSyncPolicyOwner } from "../../../packages/gs/sync/src/index.js";
import { currentRevision } from "../../../packages/gs/pull-requests/src/index.js";
import { createReviewEnvelope } from "../../../packages/gs/review-contracts/src/index.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("runs immutable diff and blame without pull requests or review", async () => {
  // Given
  const fixture = await repositoryFixture();
  const authority = await openRepositoryAuthority({
    statePath: join(fixture.root, "authority.sqlite3"),
    runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity,
    refUpdatePolicies: [],
  });
  await authority.registerRepository({
    selector: fixture.selector,
    ownerPrincipalId: "owner",
    policy: fixture.policy,
    branches: [{ protectedRef: "refs/heads/main", commit: fixture.baseCommit, tree: fixture.baseTree }],
  });
  const reader = createGitRepositoryReadService({ runtime: fixture.runtime, gitIdentity: fixture.gitIdentity });
  const diff = createDiffService({ readGate: authority, reader });
  const blame = createBlameService({ readGate: authority, reader });
  const principal = { principalId: "reader", async authorize() {} };

  // When
  const snapshot = await diff.snapshot({ ...fixture.selector, principal, baseCommit: fixture.baseCommit, headCommit: fixture.headCommit });
  const attribution = await blame.line({ ...fixture.selector, principal, commit: fixture.baseCommit, path: "README.md", line: 1 });

  // Then
  expect(snapshot.files[0]).toMatchObject({ oldPath: "README.md", newPath: "README.md" });
  expect(attribution).toMatchObject({ commit: fixture.baseCommit, path: "README.md", line: 1, author: "GS test" });
  await authority.close();
});

it("creates, edits, refreshes and discusses a pull request without review", async () => {
  // Given
  const fixture = await repositoryFixture();
  const authority = await registeredAuthority(fixture);
  const reader = createGitRepositoryReadService({ runtime: fixture.runtime, gitIdentity: fixture.gitIdentity });
  const principal = { principalId: "author", async authorize() {} };
  const pullRequests = openPullRequestService({
    stateDirectory: join(fixture.root, "pull-requests"),
    readGate: authority,
    mutationGate: authority,
    reader,
    refWriter: { async ensure(input) {
      const existing = await git(["--git-dir", input.access.target.repositoryPath, "rev-parse", "--verify", "--quiet", input.ref], true);
      if (existing === input.commit) return;
      if (existing !== "") throw new Error("pin conflict");
      await git(["--git-dir", input.access.target.repositoryPath, "update-ref", input.ref, input.commit, "0".repeat(input.commit.length)]);
    } },
  });
  const diff = createDiffService({ readGate: authority, reader, historyRefs: async (selector) =>
    (await pullRequests.ownedRefs(selector)).map((entry) => entry.ref) });
  const discussions = createDiscussionsService({ mutationGate: authority, pullRequests, diff });

  // When
  const created = await pullRequests.create({ ...fixture.selector, principal, title: "Standalone PR", sourceRef: "refs/heads/feature" });
  const edited = await pullRequests.mutate({ ...fixture.selector, principal, requestId: created.id, expectedVersion: created.version, title: "Edited PR" });
  const refreshed = await pullRequests.refresh({ ...fixture.selector, principal, requestId: edited.id, expectedVersion: edited.version });
  const revision = currentRevision(refreshed);
  const discussed = await discussions.addComment({ ...fixture.selector, principal, requestId: refreshed.id,
    expectedVersion: refreshed.version, revisionId: revision.id, body: "Exact line", anchor: { path: "README.md", side: "head", line: 1 } });

  // Then
  expect(discussed.title).toBe("Edited PR");
  expect(discussed.comments).toHaveLength(1);
  await expect(pullRequests.requestReview({ ...fixture.selector, principal, requestId: discussed.id, expectedVersion: discussed.version }))
    .rejects.toThrow(/not configured/);
  expect((await pullRequests.ownedRefs(fixture.selector)).map((entry) => entry.ref)).toHaveLength(2);
  await authority.close();
});

it.each(["mismatch", "race"] as const)("rejects review when the provider returns a %s", async (mode) => {
  // Given
  const fixture = await repositoryFixture();
  const authority = await registeredAuthority(fixture);
  const reader = createGitRepositoryReadService({ runtime: fixture.runtime, gitIdentity: fixture.gitIdentity });
  await writeFile(join(fixture.source, "README.md"), "raced\n");
  await git(["-C", fixture.source, "commit", "-am", "raced"]);
  const racedCommit = await git(["-C", fixture.source, "rev-parse", "HEAD"]);
  const racedTree = await git(["-C", fixture.source, "rev-parse", "HEAD^{tree}"]);
  await git(["--git-dir", fixture.repository, "fetch", fixture.source, `${racedCommit}:refs/heads/raced`]);
  const principal = { principalId: "author", async authorize() {} };
  const pullRequests = openPullRequestService({
    stateDirectory: join(fixture.root, "review-pull-requests"), readGate: authority, mutationGate: authority, reader,
    refWriter: { async ensure(input) { await git(["--git-dir", input.access.target.repositoryPath, "update-ref", input.ref, input.commit]); } },
    reviewRequest: { async request({ request }) {
      const candidateCommit = mode === "mismatch" ? racedCommit : fixture.headCommit;
      const candidateTree = mode === "mismatch" ? racedTree : await git(["--git-dir", fixture.repository, "rev-parse", `${fixture.headCommit}^{tree}`]);
      if (mode === "race") await git(["--git-dir", fixture.repository, "update-ref", "refs/heads/feature", racedCommit]);
      return createReviewEnvelope({
        identity: { schemaVersion: 1, namespaceId: request.namespaceId, repositoryId: request.repositoryId,
          inputs: { [request.repositoryId]: { commit: candidateCommit, tree: candidateTree } }, protectedRef: request.protectedRef ?? "refs/heads/main",
          proposalRef: request.proposalRef, expectedProtectedHead: fixture.baseCommit, candidateCommit, candidateTree,
          policyRevision: fixture.policy.policyRevision, requiredReviewRevision: "a".repeat(64), requiredReviewerIds: [], changes: [], patch: "", patchBytes: "" },
        policyDigest: "b".repeat(64), attachments: [], createdAt: new Date().toISOString(),
      });
    } },
  });
  const created = await pullRequests.create({ ...fixture.selector, principal, title: "Reviewed PR", sourceRef: "refs/heads/feature" });

  // When
  const review = pullRequests.requestReview({ ...fixture.selector, principal, requestId: created.id, expectedVersion: created.version });

  // Then
  await expect(review).rejects.toThrow(mode === "mismatch" ? /match/i : /stale/i);
  await authority.close();
});

it("keeps release pull request review and merged refresh bound to release", async () => {
  // Given
  const fixture = await repositoryFixture({}, true);
  const authority = await registeredAuthority(fixture, [], [{ name: "test-promotion", revision: "e".repeat(64), async authorize() {} }]);
  const reader = createGitRepositoryReadService({ runtime: fixture.runtime, gitIdentity: fixture.gitIdentity });
  const principal = { principalId: "author", async authorize() {} };
  const pullRequests = openPullRequestService({
    stateDirectory: join(fixture.root, "release-pull-requests"), readGate: authority, mutationGate: authority, reader,
    refWriter: { async ensure(input) { await git(["--git-dir", input.access.target.repositoryPath, "update-ref", input.ref, input.commit]); } },
    reviewRequest: { async request({ access, request }) {
      const candidateTree = await reader.readCommitTree({ principalId: principal.principalId, target: access.target }, fixture.headCommit);
      return createReviewEnvelope({ identity: { schemaVersion: 1, namespaceId: request.namespaceId, repositoryId: request.repositoryId,
        inputs: { [request.repositoryId]: { commit: fixture.headCommit, tree: candidateTree } }, protectedRef: request.protectedRef ?? "refs/heads/main",
        proposalRef: request.proposalRef, expectedProtectedHead: fixture.baseCommit, candidateCommit: fixture.headCommit, candidateTree,
        policyRevision: fixture.policy.policyRevision, requiredReviewRevision: "a".repeat(64), requiredReviewerIds: [], changes: [], patch: "", patchBytes: "" },
        policyDigest: "b".repeat(64), attachments: [], createdAt: new Date().toISOString() });
    } },
  });
  const created = await pullRequests.create({ ...fixture.selector, principal, title: "Release PR", sourceRef: "refs/heads/feature", targetRef: "refs/heads/release" });

  // When
  const reviewed = await pullRequests.requestReview({ ...fixture.selector, principal, requestId: created.id, expectedVersion: created.version });
  await authority.promote({ ...fixture.selector, protectedRef: "refs/heads/release", proposalRef: "refs/heads/feature",
    expectedCommit: fixture.baseCommit, candidateCommit: fixture.headCommit, candidateTree: fixture.headTree,
    authorizationId: "c".repeat(64), evidenceDigest: "d".repeat(64) });
  const refreshed = await pullRequests.refresh({ ...fixture.selector, principal, requestId: created.id, expectedVersion: created.version });

  // Then
  expect(reviewed.review.review.protectedRef).toBe("refs/heads/release");
  expect(refreshed.state).toBe("merged");
  expect(await git(["--git-dir", fixture.repository, "rev-parse", "refs/heads/release"])).toBe(fixture.headCommit);
  expect(await git(["--git-dir", fixture.repository, "rev-parse", "refs/heads/main"])).toBe(fixture.baseCommit);
  await authority.close();
});

it("fetches, proposes and publishes without CI or review", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "gs-sync-service-"));
  roots.push(root);
  const upstream = join(root, "upstream.git");
  await git(["init", "--bare", upstream]);
  const syncPolicy = { upstream: { url: pathToFileURL(upstream).href, branch: "development" }, publish: { main: "published" } };
  const fixture = await repositoryFixture({ "git-sync": syncPolicy });
  await git(["-C", fixture.source, "push", upstream, `${fixture.headCommit}:refs/heads/development`]);
  const authority = await registeredAuthority(fixture, [gitSyncPolicyOwner(true)]);
  const proposed: string[] = [];
  const service = createSyncService({
    mutationGate: authority,
    proposalConsumer: { async consume(input) { proposed.push(...input.refs); } },
    git: createNodeGitSyncTransport({ gitExecutable: fixture.runtime.gitExecutable, gitIdentity: fixture.gitIdentity, allowLocalRemotes: true }),
    currentAuthorityEpoch: () => authority.authorityEpoch,
  });
  const principal = { principalId: "sync", async authorize() {} };

  // When
  const fetched = await service.synchronize({ ...fixture.selector, principal, operation: "fetch" });
  const proposal = await service.synchronize({ ...fixture.selector, principal, operation: "propose" });
  const published = await service.synchronize({ ...fixture.selector, principal, operation: "publish" });

  // Then
  expect(fetched.outcome).toBe("fetched");
  expect(proposal.outcome).toBe("proposed");
  expect(proposed).toEqual(proposal.outcome === "proposed" ? [proposal.proposalRef] : []);
  expect(published).toMatchObject({ outcome: "published", sourceCommit: fixture.baseCommit, targetRef: "refs/heads/published" });
  expect(await git(["--git-dir", upstream, "rev-parse", "refs/heads/published"])).toBe(fixture.baseCommit);
  await authority.close();
});

async function registeredAuthority(fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  policySectionOwners: Parameters<typeof openRepositoryAuthority>[0]["policySectionOwners"] = [],
  refUpdatePolicies: Parameters<typeof openRepositoryAuthority>[0]["refUpdatePolicies"] = []) {
  const authority = await openRepositoryAuthority({ statePath: join(fixture.root, "authority.sqlite3"), runtime: fixture.runtime,
    gitIdentity: fixture.gitIdentity, refUpdatePolicies, policySectionOwners });
  await authority.registerRepository({ selector: fixture.selector, ownerPrincipalId: "owner", policy: fixture.policy,
    branches: fixture.branches });
  return authority;
}

async function repositoryFixture(extensions: Readonly<Record<string, unknown>> = {}, multiBranch = false) {
  const root = await mkdtemp(join(tmpdir(), "gs-optional-services-"));
  roots.push(root);
  const storageRoot = join(root, "storage");
  const source = join(root, "source");
  const selector = { namespaceId: "tenant", repositoryId: "main" } as const;
  const repository = join(storageRoot, selector.namespaceId, `${selector.repositoryId}.git`);
  await mkdir(join(storageRoot, selector.namespaceId), { recursive: true });
  await git(["init", source]);
  await git(["-C", source, "config", "user.name", "GS test"]);
  await git(["-C", source, "config", "user.email", "gs@example.invalid"]);
  await writeFile(join(source, "README.md"), "base\n");
  await git(["-C", source, "add", "README.md"]);
  await git(["-C", source, "commit", "-m", "base"]);
  const baseCommit = await git(["-C", source, "rev-parse", "HEAD"]);
  const baseTree = await git(["-C", source, "rev-parse", "HEAD^{tree}"]);
  await writeFile(join(source, "README.md"), "head\n");
  await git(["-C", source, "commit", "-am", "head"]);
  const headCommit = await git(["-C", source, "rev-parse", "HEAD"]);
  const headTree = await git(["-C", source, "rev-parse", "HEAD^{tree}"]);
  const gitVersion = (await git(["--version"])).replace(/^git version /, "");
  const runtime = { gitExecutable: "/usr/bin/git", gitVersion, storageRoot };
  await initializeRepository(runtime, selector);
  await git(["--git-dir", repository, "fetch", source, `${baseCommit}:refs/heads/main`, `${baseCommit}:refs/heads/release`, `${headCommit}:refs/heads/feature`]);
  const managedBranches = multiBranch ? { defaultRef: "refs/heads/main", branches: {
    "refs/heads/main": { review: true }, "refs/heads/release": { review: true },
  } } : {};
  const policyBase = { schemaVersion: 1 as const, protectedRef: "refs/heads/main", ...managedBranches, extensions };
  return {
    root,
    source,
    repository,
    selector,
    runtime,
    gitIdentity: await assertGitVersion(runtime),
    policy: { ...policyBase, policyRevision: repositoryPolicyRevision(policyBase) },
    baseCommit,
    baseTree,
    headCommit,
    headTree,
    branches: multiBranch
      ? [{ protectedRef: "refs/heads/main", commit: baseCommit, tree: baseTree }, { protectedRef: "refs/heads/release", commit: baseCommit, tree: baseTree }]
      : [{ protectedRef: "refs/heads/main", commit: baseCommit, tree: baseTree }],
  };
}

async function git(args: readonly string[], allowFailure = false): Promise<string> {
  try { return (await execute("/usr/bin/git", args, {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  })).stdout.trim(); } catch (error) {
    if (allowFailure && error instanceof Error && "code" in error && error.code === 1) return "";
    throw error;
  }
}
