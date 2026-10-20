import { MergeAuthorizationStore, promoteInstalledNativeReview, controlPlanePlugin as mergePlugin } from "@slop-lab/dim-control-plane-plugin-merge-policy";
import { mergeQualityGuardExtension, type MergeQualityGuard } from "@slop-lab/dim-control-plane-plugin-merge-policy/extensions";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { compareAndSwapProtectedRef, readProtectedRefTransition, refUpdatePolicyExtension, refUpdatePolicies, repositoryExtension, type RefUpdatePolicy } from "@slop-lab/dim-control-plane-plugin-git-repositories/extensions";
import { type CodeReviewService } from "@slop-lab/dim-control-plane-plugin-code-review/extensions";
import { basic, fixture, generationId, git, reviewer } from "./optionalFeaturesFixture.js";

async function candidate(f: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(join(f.source, "README.md"), "candidate\n"); const candidateCommit = await f.commit();
  await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
  const candidateTree = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  return { projectId: "project", repositoryId: "main", proposalRef: f.proposalRef, expectedCommit: f.initial,
    candidateCommit, candidateTree, authorizationId: "b".repeat(64), evidenceDigest: "c".repeat(64) };
}
function emptyOptions(options: unknown) { if (options === null || typeof options !== "object" || Object.keys(options).length !== 0) throw new Error("empty options required"); }
it("intersects independent policies before intent, records their revisions and fails closed if one changes", async () => {
  let deny = true, mutate = false;
  const seen: string[] = [];
  const first: RefUpdatePolicy = { name: "first", revision: "1".repeat(64), validate: emptyOptions, async check({ context, target, change }) {
    expect(context.runtime.expectedGenerationId).toBe(generationId); expect(target.imported.projectId).toBe(change.projectId);
    expect(target.currentHead.commit).toBe(change.expectedCommit); seen.push("first");
  } };
  const second = { name: "second", revision: "2".repeat(64), validate: emptyOptions, async check() { seen.push("second"); if (mutate) second.revision = "3".repeat(64); if (deny) throw new Error("second policy denied"); } };
  const f = await fixture(false, [refUpdatePolicyExtension(first), refUpdatePolicyExtension(second)], undefined, undefined, { first: {}, second: {} });
  try {
    const input = await candidate(f), change = () => f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, input));
    await expect(change()).rejects.toThrow(/second policy denied/); expect(seen).toEqual(["first", "second"]);
    expect(readProtectedRefTransition(f.service.context.runtime, input.authorizationId)).toBeUndefined();
    deny = false; mutate = true;
    await expect(change()).rejects.toThrow(/changed during authorization/);
    expect(readProtectedRefTransition(f.service.context.runtime, input.authorizationId)).toBeUndefined();
    mutate = false;
    expect(await change()).toEqual({ outcome: "promoted", sequence: 1 });
    expect(readProtectedRefTransition(f.service.context.runtime, input.authorizationId)?.refPolicyRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(() => refUpdatePolicies([refUpdatePolicyExtension(first), refUpdatePolicyExtension(first)])).toThrow(/duplicate/);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);
it("requires current human approval at direct CAS, and refuses a removed mandatory review guard", async () => {
  const f = await fixture(true);
  try {
    const input = await candidate(f);
    const change = () => f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, input));
    await expect(change()).rejects.toThrow(/every required human approval/);
    const stripped = { ...f.service.context, extensions: f.service.context.extensions.filter(({ kind }) => kind !== "dim.git-repositories.ref-update-policy") };
    await expect(f.service.context.serialize(() => compareAndSwapProtectedRef(stripped, input))).rejects.toThrow(/requires ref update policy/);
    const extension = f.service.context.extensions.find(({ kind }) => kind === "dim.code-review.service");
    if (!extension) throw new Error("review service missing");
    const envelope = await (extension.value as CodeReviewService).create(f.service.context, { projectId: "project", repositoryId: "main", proposalRef: f.proposalRef });
    const approved = await fetch(`${f.origin}/v1/projects/project/repositories/main/reviews/${envelope.review.reviewId}/approvals`, { method: "POST", headers: { authorization: basic(reviewer), "content-type": "application/json", "x-dim-generation-id": generationId }, body: JSON.stringify({ requestId: randomUUID() }) });
    expect(approved.status, await approved.clone().text()).toBe(201);
    expect(await change()).toEqual({ outcome: "promoted", sequence: 1 });
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);
it("keeps non-fast-forward and deletion rejection independent of selected custom policies", async () => {
  const allow: RefUpdatePolicy = { name: "allow", revision: "a".repeat(64), validate: emptyOptions, async check() {} };
  const f = await fixture(false, [refUpdatePolicyExtension(allow)], undefined, undefined, { allow: {} });
  try {
    const input = await candidate(f);
    const unrelated = (await git("/usr/bin/git", ["-C", f.source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", input.candidateTree, "-m", "unrelated root"])).stdout.trim();
    const unrelatedRef = `${f.proposalRef}-unrelated`;
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `${unrelated}:${unrelatedRef}`]);
    await expect(f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, { ...input, proposalRef: unrelatedRef, candidateCommit: unrelated }))).rejects.toThrow(/does not descend/);
    await expect(f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, { ...input, candidateCommit: "0" }))).rejects.toThrow();
    expect(readProtectedRefTransition(f.service.context.runtime, input.authorizationId)).toBeUndefined();
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("requires owned merge authorization at direct CAS and rechecks quality after authorization preparation", async () => {
  let ready = true;
  const quality: MergeQualityGuard = { name: "build-check", async check() { if (!ready) throw new Error("required build is stale"); return []; } };
  const merge = await mergePlugin.configure({ hostPromoters: [] });
  const owner = repositoryExtension({ name: "build-check", policyName: "build-check", async attach() { return { async close() {} }; } });
  const f = await fixture(true, [...(merge.extensions ?? []), owner, mergeQualityGuardExtension(quality)], undefined, undefined, { "merge-policy": {}, "build-check": {} });
  try {
    const input = await candidate(f);
    const extension = f.service.context.extensions.find(({ kind }) => kind === "dim.code-review.service");
    if (!extension) throw new Error("review service missing");
    const envelope = await (extension.value as CodeReviewService).create(f.service.context, { projectId: "project", repositoryId: "main", proposalRef: f.proposalRef });
    const approved = await fetch(`${f.origin}/v1/projects/project/repositories/main/reviews/${envelope.review.reviewId}/approvals`, { method: "POST", headers: { authorization: basic(reviewer), "content-type": "application/json", "x-dim-generation-id": generationId }, body: JSON.stringify({ requestId: randomUUID() }) });
    expect(approved.status, await approved.clone().text()).toBe(201);
    await expect(f.service.context.serialize(() => compareAndSwapProtectedRef(f.service.context, input))).rejects.toThrow(/exact owned merge authorization/);
    const store = new MergeAuthorizationStore(join(f.root, "state/.extensions/merge-policy/authorizations.sqlite3"));
    try {
      await expect(f.service.context.serialize(() => promoteInstalledNativeReview({ repository: f.service.context, store, guards: [quality], hooks: { afterIntent() { ready = false; } } }, "project", "main", envelope.review.reviewId))).rejects.toThrow(/build is stale/);
      expect((await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(input.expectedCommit);
      ready = true;
      expect(await f.service.context.serialize(() => promoteInstalledNativeReview({ repository: f.service.context, store, guards: [quality] }, "project", "main", envelope.review.reviewId))).toMatchObject({ outcome: "promoted" });
    } finally { store.close(); }
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);
