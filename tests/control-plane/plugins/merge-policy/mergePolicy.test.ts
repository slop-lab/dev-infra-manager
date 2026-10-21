import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertRequiredMergeQualityGuards, type MergeQualityGuard } from "../../../../packages/control-plane/plugins/merge-policy/src/plugin-api.js";
import { MergeAuthorizationStore, authorizationIdentity, type MergeAuthorization } from "../../../../packages/control-plane/plugins/merge-policy/src/state.js";
import { controlPlanePlugin } from "../../../../packages/control-plane/plugins/merge-policy/src/index.js";
import { startControlPlanePlugins } from "@slop-lab/dim-control-plane-core";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
it("fails closed for trusted CI policy even if an absent preparation left no review attachment", () => {
  const guard: MergeQualityGuard = { name: "git-ci", async check() { return []; } };
  const policy = { "code-review": { requiredReviewerIds: ["owner"] }, "git-ci": { requiredJobs: ["checks"] } };
  expect(() => assertRequiredMergeQualityGuards(policy, [], [])).toThrow(/git-ci.*unavailable/);
  expect(() => assertRequiredMergeQualityGuards({ "code-review": {} }, [{ kind: "git-ci", id: "plan", digest: "a".repeat(64) }], [])).toThrow(/git-ci.*unavailable/);
  expect(() => assertRequiredMergeQualityGuards(policy, [], [guard])).not.toThrow();
  expect(() => assertRequiredMergeQualityGuards(policy, [], [guard, guard])).toThrow(/duplicate/);
  expect(() => assertRequiredMergeQualityGuards({ "code-review": {}, "merge-policy": {} }, [], [])).not.toThrow();
  expect(() => assertRequiredMergeQualityGuards({ "git-sync": {} }, [], [], [], ["git-sync"])).not.toThrow();
  expect(() => assertRequiredMergeQualityGuards({ "git-sync": {} }, [{ kind: "git-sync", id: "check", digest: "a".repeat(64) }], [], [], ["git-sync"])).toThrow(/git-sync.*unavailable/);
  expect(() => assertRequiredMergeQualityGuards({ "git-sync": {}, "git-ci": {} }, [], [], [], ["git-sync"])).toThrow(/git-ci.*unavailable/);
});
it("persists exact approved evidence independently, preserving pending versus finalized receipts through restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-merge-evidence-")); roots.push(root);
  const file = join(root, "authorizations.sqlite3");
  const authorization: MergeAuthorization = { projectId: "project-a", repositoryId: "public", reviewId: "a".repeat(64), generationId: "b".repeat(64),
    envelopeId: "c".repeat(64), policyDigest: "d".repeat(64), protectedRef: "refs/heads/main", proposalRef: `refs/heads/proposals/${randomUUID()}/change`,
    expectedCommit: "1".repeat(40), candidateCommit: "2".repeat(40), candidateTree: "3".repeat(40),
    approvals: [{ reviewerId: "owner", recordDigest: "e".repeat(64) }], attachments: [{ kind: "git-ci", id: "plan", digest: "f".repeat(64) }] };
  let store = new MergeAuthorizationStore(file);
  const prepared = store.prepare(authorization); expect(prepared.sequence).toBeUndefined();
  expect(store.prepare(authorization)).toEqual(prepared);
  store.close(); store = new MergeAuthorizationStore(file);
  expect(store.read()).toEqual([prepared]);
  store.finalize(prepared.authorizationId, 1); store.finalize(prepared.authorizationId, 1);
  expect(() => store.finalize(prepared.authorizationId, 2)).toThrow(/conflicts/);
  expect(() => store.finalize("0".repeat(64), 1)).toThrow(/conflicts/);
  store.close(); store = new MergeAuthorizationStore(file);
  expect(store.read()[0]?.sequence).toBe(1);
  expect(authorizationIdentity({ ...authorization, policyDigest: "f".repeat(64) })).not.toEqual(authorizationIdentity(authorization));
  store.close();
});
it("requires repository and review services before starting optional merge policy", async () => {
  await expect(startControlPlanePlugins([{ plugin: controlPlanePlugin, config: { hostPromoters: [{ hostId: "operator", username: "promoter", password: "private-".repeat(8) }] } }], new AbortController().signal)).rejects.toThrow(/missing required/);
});

it("accepts an empty operator role set without granting any promotion authority", async () => {
  const prepared = await controlPlanePlugin.configure({ hostPromoters: [] });
  expect(prepared.extensions?.some(({ kind }) => kind === "dim.git-repositories.extension")).toBe(true);
});
