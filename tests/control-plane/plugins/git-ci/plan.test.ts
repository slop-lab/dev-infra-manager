import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAuthoritativeNativeReviewEnvelope } from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-schema.js";
import { saveAuthoritativeNativeReviewEnvelope } from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-review-store.js";
import { gitCiEnvelope, saveGitCiPlan, type GitCiPlan } from "../../../../packages/control-plane/plugins/git-ci/src/plan-store.js";
import { gitCiPolicy, parseGitCiPolicy, requiredJobsRevision } from "../../../../packages/control-plane/plugins/git-ci/src/policy.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const primary = { commit: "2".repeat(40), tree: "3".repeat(40) };
const identity = { schemaVersion: 2 as const, serviceId: "native-main" as const, projectId: "project-a", repositoryId: "private",
  inputs: { private: primary }, protectedRef: "refs/heads/main", proposalRef: `refs/heads/proposals/${Buffer.alloc(32, 1).toString("base64url")}/change`,
  expectedProtectedHead: "1".repeat(40), candidateCommit: primary.commit, candidateTree: primary.tree,
  policyRevision: "4".repeat(64), requiredReviewRevision: "4".repeat(64), workspaceId: Buffer.alloc(32, 1).toString("base64url"),
  requiredReviewerIds: ["owner"], changes: [], patch: "", patchBytes: "" };
const plan: GitCiPlan = { schemaVersion: 1, projectId: identity.projectId, repositoryId: identity.repositoryId,
  expectedProtectedHead: identity.expectedProtectedHead, candidateCommit: primary.commit, candidateTree: primary.tree,
  policyDigest: "5".repeat(64), qualityRevision: requiredJobsRevision([]), requiredJobs: [],
  planning: { status: "valid", configBlob: null, jobs: [] } };
async function fixture() { const root = await mkdtemp(join(tmpdir(), "dim-git-ci-plan-")); roots.push(root); return root; }
it("keeps CI plan storage separate from a usable review without a CI attachment", async () => {
  const repository = await fixture();
  const review = createAuthoritativeNativeReviewEnvelope({ identity, policyDigest: plan.policyDigest, attachments: [], createdAt: new Date().toISOString() });
  await saveAuthoritativeNativeReviewEnvelope(repository, review);
  expect(await gitCiEnvelope(repository, review)).toBeUndefined();
  expect(review).not.toHaveProperty("planning"); expect(review).not.toHaveProperty("events");
});
it("binds an immutable plan to its review and rejects changed plan bytes rather than executing them", async () => {
  const repository = await fixture(), attachment = await saveGitCiPlan(repository, plan);
  const review = createAuthoritativeNativeReviewEnvelope({ identity, policyDigest: plan.policyDigest, attachments: [attachment], createdAt: new Date().toISOString() });
  await saveAuthoritativeNativeReviewEnvelope(repository, review);
  expect((await gitCiEnvelope(repository, review))?.review.reviewId).toBe(review.review.reviewId);
  expect(await saveGitCiPlan(repository, plan)).toEqual(attachment);
  const file = join(repository, "dim-git-ci-plans", `${attachment.id}.json`);
  const before = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...before, candidateCommit: "f".repeat(40) }));
  await expect(gitCiEnvelope(repository, review)).rejects.toThrow(/does not match/);
});
it("owns its repository allowlist and derives job revisions without a redundant policy input", () => {
  const policy = { schemaVersion: 1 as const, protectedRef: "refs/heads/main", policyRevision: "a".repeat(64), extensions: {} };
  expect(gitCiPolicy(policy, "public").ciRepositoryIds).toEqual(["public"]);
  expect(() => parseGitCiPolicy({ ciRepositoryIds: ["public"], requiredJobs: [] }, "private")).toThrow(/allowlist/);
  expect(() => parseGitCiPolicy({ ciRepositoryIds: ["public"], requiredJobs: [], requiredJobSetRevision: "a".repeat(64) })).toThrow();
});
