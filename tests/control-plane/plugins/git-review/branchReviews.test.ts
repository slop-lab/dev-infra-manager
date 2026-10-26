import { defaultRepositoryReviewExtensions } from "../../../../packages/host/plugins/native-git/src/defaultRepositoryReviewPolicy.js";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as decisionStore from "../../../../packages/control-plane/plugins/git-review/src/authoritative-native-decision-store.js";
import * as freshness from "../../../../packages/control-plane/plugins/git-review/src/native-human-reviewer-freshness.js";
import { nativeRepositoryPolicyRevision } from "@slop-lab/dim-contracts-git";
import { reviewChangeMatcherExtension } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { controlPlanePlugin as mergePlugin } from "@slop-lab/dim-control-plane-plugin-git-merge-policy";
import { basic, fixture, generationId, git, record, reviewer, text, token } from "../git-repositories/optionalFeaturesFixture.js";

it("binds main PR rules to its target while development stays approval-free, then prepares development to main", async () => {
  const promoter = { hostId: "host-a", username: "promoter", password: token(10) };
  const merge = await mergePlugin.configure({ hostPromoters: [promoter] });
  const custom = reviewChangeMatcherExtension({ name: "custom", revision: "7".repeat(64), validate() {}, async matches({ changes }) { return changes.some(({ newPath }) => newPath === "custom.txt"); } });
  const reviewPolicy = { requiredReviewerIds: [], pathReviewerRules: [{ pathPrefix: "boundary.txt", reviewerIds: ["owner"] }], changeReviewerRules: [
    { matcher: "json-field", options: { path: "runtime.json", pointer: "/isolation" }, reviewerIds: ["owner"] },
    { matcher: "custom", options: {}, reviewerIds: ["owner"] }
  ] };
  const f = await fixture(true, [...merge.extensions ?? [], custom], reviewPolicy, [reviewer], { "merge-policy": {} });
  const headers = (credential: { username: string; password: string }) => ({ authorization: basic(credential), "x-dim-generation-id": generationId, "content-type": "application/json" });
  const path = `${f.origin}/v1/projects/project/repositories/main`;
  const post = (suffix: string, body: unknown, credential: { username: string; password: string } = reviewer) => fetch(path + suffix, { method: "POST", headers: headers(credential), body: JSON.stringify(body) });
  try {
    const previous = record(await (await fetch(path + "/policy", { headers: headers({ username: "importer", password: token(1) }) })).json());
    const policyInput = { protectedRef: "refs/heads/main", defaultRef: "refs/heads/main", branches: { "refs/heads/main": { review: true }, "refs/heads/development": { review: false } }, extensions: { "code-review": reviewPolicy, "merge-policy": {} } };
    const updated = await post("/policy", { schemaVersion: 1, expectedPolicyDigest: previous.policyDigest, expectedProtectedHead: record(previous.currentHead).commit, policy: { schemaVersion: 1, ...policyInput, policyRevision: nativeRepositoryPolicyRevision(policyInput) } }, { username: "importer", password: token(1) });
    expect(updated.status, await updated.clone().text()).toBe(200);
    for (const [file, contents, required] of [["README.md", "ordinary change\n", []], ["boundary.txt", "boundary change\n", ["owner"]], ["runtime.json", '{"isolation":false}', ["owner"]], ["runtime.json", '{"isolation":false,"theme":"light"}', []], ["custom.txt", "custom rule\n", ["owner"]]] as const) {
      await writeFile(join(f.source, file), contents);
      await git("/usr/bin/git", ["-C", f.source, "add", file]);
      await git("/usr/bin/git", ["-C", f.source, "add", "."]);
      await f.commit();
      await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
      for (const [protectedRef, reviewers] of [["refs/heads/main", required], ["refs/heads/development", []]] as const) {
        const resolved = await post("/reviews/resolve", { schemaVersion: 1, proposalRef: f.proposalRef, protectedRef });
        expect(resolved.status, await resolved.clone().text()).toBe(200);
        const review = record(record(await resolved.json()).review);
        expect(review.protectedRef).toBe(protectedRef); expect(review.requiredReviewerIds).toEqual(reviewers);
        if (protectedRef === "refs/heads/main" && file !== "custom.txt") {
          if (reviewers.length > 0) expect((await post(`/reviews/${text(review, "reviewId")}/approvals`, { requestId: randomUUID() })).status).toBe(201);
          else expect((await post(`/reviews/${text(review, "reviewId")}/approvals`, { requestId: randomUUID() })).status).toBe(403);
          const promoted = await post(`/reviews/${text(review, "reviewId")}/promotions`, { schemaVersion: 1 }, promoter);
          expect(promoted.status, await promoted.clone().text()).toBe(201);
        }
        if (protectedRef === "refs/heads/development") {
          const promoted = await post(`/reviews/${text(review, "reviewId")}/promotions`, { schemaVersion: 1 }, promoter);
          expect(promoted.status, await promoted.clone().text()).toBe(201);
        }
      }
    }
    const prepared = await post("/merges", { schemaVersion: 1, sourceRef: "refs/heads/development", targetRef: "refs/heads/main" }, promoter);
    expect(prepared.status, await prepared.clone().text()).toBe(200);
    const result = record(await prepared.json()); expect(result.outcome).toBe("proposed");
    const evidence = await fetch(`${path}/reviews/${text(result, "reviewId")}`, { headers: headers(reviewer) });
    expect(evidence.status).toBe(200);
    const review = record(record(await evidence.json()).review);
    expect(review.protectedRef).toBe("refs/heads/main"); expect(review.requiredReviewerIds).toEqual(["owner"]);
    expect((await post(`/reviews/${text(result, "reviewId")}/promotions`, { schemaVersion: 1 }, promoter)).status).toBe(409);
    for (const sourceRef of ["refs/heads/unmanaged", "refs/heads/main"]) expect((await post("/merges", { schemaVersion: 1, sourceRef, targetRef: "refs/heads/main" }, promoter)).status).toBe(409);
    const list = async () => {
      const response = await fetch(path + "/reviews", { headers: headers(reviewer) });
      expect(response.status, await response.clone().text()).toBe(200);
      const value: unknown = await response.json();
      if (!Array.isArray(value)) throw new Error("review summaries are missing");
      return value.map(record);
    };
    const decisionsRead = vi.spyOn(decisionStore, "readAuthoritativeNativeDecisions"), freshnessCheck = vi.spyOn(freshness, "nativeHumanReviewStaleReasons");
    const bothBranches = await list();
    expect(decisionsRead).toHaveBeenCalledTimes(1);
    expect(freshnessCheck).not.toHaveBeenCalled();
    decisionsRead.mockRestore(); freshnessCheck.mockRestore();
    expect(bothBranches.some((entry) => entry.protectedRef === "refs/heads/development" && entry.status === "stale")).toBe(true);
    expect(bothBranches.find((entry) => entry.reviewId === result.reviewId)?.status).toBe("pending");
    const beforeRemoval = record(await (await fetch(path + "/policy", { headers: headers({ username: "importer", password: token(1) }) })).json());
    const mainOnly = { ...policyInput, branches: { "refs/heads/main": { review: true } } };
    const removed = await post("/policy", { schemaVersion: 1, expectedPolicyDigest: beforeRemoval.policyDigest, expectedProtectedHead: record(beforeRemoval.currentHead).commit,
      policy: { schemaVersion: 1, ...mainOnly, policyRevision: nativeRepositoryPolicyRevision(mainOnly) } }, { username: "importer", password: token(1) });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const refreshed = await post("/reviews/resolve", { schemaVersion: 1, proposalRef: result.proposalRef, protectedRef: "refs/heads/main" });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const refreshedReview = record(record(await refreshed.json()).review);
    const mainAndHistory = await list();
    expect(mainAndHistory.find((entry) => entry.reviewId === refreshedReview.reviewId)?.status).toBe("pending");
    expect(mainAndHistory.find((entry) => entry.reviewId === result.reviewId)?.status).toBe("stale");
    const retired = mainAndHistory.filter((entry) => entry.protectedRef === "refs/heads/development");
    expect(retired.length).toBeGreaterThan(1); expect(retired.every((entry) => entry.status === "stale")).toBe(true);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("ordinary imported defaults resolve and promote normal changes while .dim changes wait for the importing reviewer", async () => {
  const promoter = { hostId: "host-a", username: "promoter", password: token(10) };
  const merge = await mergePlugin.configure({ hostPromoters: [promoter] });
  const defaults = defaultRepositoryReviewExtensions(undefined, reviewer.reviewerId) as Record<string, unknown>;
  const f = await fixture(true, merge.extensions ?? [], defaults["code-review"], [reviewer], { "merge-policy": {} });
  const path = `${f.origin}/v1/projects/project/repositories/main`;
  const post = (suffix: string, body: unknown, credential = reviewer as { username: string; password: string }) => fetch(path + suffix, { method: "POST", headers: {
    authorization: basic(credential), "content-type": "application/json", "x-dim-generation-id": generationId }, body: JSON.stringify(body) });
  try {
    for (const sensitive of [false, true]) {
      if (sensitive) { await mkdir(join(f.source, ".dim")); await writeFile(join(f.source, ".dim/runtime.json"), '{"isolation":"changed"}'); }
      else await writeFile(join(f.source, "README.md"), "ordinary change\n");
      await git("/usr/bin/git", ["-C", f.source, "add", "."]);
      await f.commit();
      await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
      const resolved = await post("/reviews/resolve", { schemaVersion: 1, proposalRef: f.proposalRef });
      expect(resolved.status, await resolved.clone().text()).toBe(200);
      const review = record(record(await resolved.json()).review), reviewId = text(review, "reviewId");
      expect(review.requiredReviewerIds).toEqual(sensitive ? [reviewer.reviewerId] : []);
      if (sensitive) {
        expect((await post(`/reviews/${reviewId}/promotions`, { schemaVersion: 1 }, promoter)).status).toBe(409);
        expect((await post(`/reviews/${reviewId}/approvals`, { requestId: randomUUID() })).status).toBe(201);
      }
      expect((await post(`/reviews/${reviewId}/promotions`, { schemaVersion: 1 }, promoter)).status).toBe(201);
    }
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("rejects updates that remove review configuration from a review-enabled branch without changing its policy", async () => {
  const f = await fixture(true);
  const path = `${f.origin}/v1/projects/project/repositories/main/policy`;
  const headers = { authorization: basic({ username: "importer", password: token(1) }), "content-type": "application/json", "x-dim-generation-id": generationId };
  try {
    const before = record(await (await fetch(path, { headers })).json());
    const next = { protectedRef: text(record(before.policy), "protectedRef"), extensions: {} };
    const response = await fetch(path, { method: "POST", headers, body: JSON.stringify({ schemaVersion: 1, expectedPolicyDigest: before.policyDigest,
      expectedProtectedHead: record(before.currentHead).commit, policy: { schemaVersion: 1, ...next, policyRevision: nativeRepositoryPolicyRevision(next) } }) });
    expect(response.status).toBe(400);
    const after = record(await (await fetch(path, { headers })).json());
    expect(after.policyDigest).toBe(before.policyDigest);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

async function ordinaryMergeFixture() {
  const promoter = { hostId: "host-a", username: "promoter", password: token(10) };
  const merge = await mergePlugin.configure({ hostPromoters: [promoter] });
  const f = await fixture(true, merge.extensions ?? [], undefined, [reviewer], { "merge-policy": {} });
  const repository = join(f.root, "state/project/main.git"), path = `${f.origin}/v1/projects/project/repositories/main`;
  const post = (suffix: string, body: unknown, credential = promoter as { username: string; password: string }) => fetch(path + suffix, { method: "POST", headers: {
    authorization: basic(credential), "content-type": "application/json", "x-dim-generation-id": generationId }, body: JSON.stringify(body) });
  const prepare = (sourceRef: string, targetRef = "refs/heads/main") => post("/merges", { schemaVersion: 1, sourceRef, targetRef });
  const head = async (ref = "refs/heads/main") => (await git("/usr/bin/git", ["--git-dir", repository, "rev-parse", ref])).stdout.trim();
  const push = async (branch: string) => { await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:refs/heads/${branch}`]); };
  const approve = (reviewId: string) => post(`/reviews/${reviewId}/approvals`, { requestId: randomUUID() }, reviewer);
  return { ...f, repository, path, post, prepare, head, push, approve };
}

it("prepares an ordinary pushed branch idempotently, pins its commit after moves and requires approval before promotion", async () => {
  const f = await ordinaryMergeFixture();
  try {
    await writeFile(join(f.source, "README.md"), "ordinary branch candidate\n");
    const first = await f.commit(); await f.push("development-tmp");
    const response = await f.prepare("refs/heads/development-tmp");
    expect(response.status, await response.clone().text()).toBe(200);
    const prepared = record(await response.json()), reviewId = text(prepared, "reviewId");
    expect(prepared).toMatchObject({ outcome: "proposed", sourceCommit: first, candidateCommit: first, expectedProtectedHead: f.initial });
    expect(await f.head()).toBe(f.initial);
    const repeated = await f.prepare("refs/heads/development-tmp");
    expect(await repeated.json()).toEqual(prepared);
    expect((await f.post(`/reviews/${reviewId}/promotions`, { schemaVersion: 1 })).status).toBe(409);
    expect(await f.head()).toBe(f.initial);

    await writeFile(join(f.source, "README.md"), "source moved after preparation\n");
    const second = await f.commit(); await f.push("development-tmp");
    expect(await f.head(text(prepared, "proposalRef"))).toBe(first);
    const moved = record(await (await f.prepare("refs/heads/development-tmp")).json());
    expect(moved.sourceCommit).toBe(second); expect(moved.reviewId).not.toBe(reviewId);
    const evidence = record(await (await fetch(`${f.path}/reviews/${reviewId}`, { headers: {
      authorization: basic(reviewer), "x-dim-generation-id": generationId } })).json());
    expect(record(evidence.review).candidateCommit).toBe(first);
    expect((await f.approve(reviewId)).status).toBe(201);
    expect((await f.post(`/reviews/${reviewId}/promotions`, { schemaVersion: 1 })).status).toBe(201);
    expect(await f.head()).toBe(first);
    expect(await f.head("refs/heads/development-tmp")).toBe(second);
    const unchanged = record(await (await f.prepare("refs/heads/main", "refs/heads/main")).json());
    expect(unchanged.error).toMatch(/must differ/);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("creates a reviewed merge for divergent ordinary branches and reports conflicts without writing the target", async () => {
  const f = await ordinaryMergeFixture();
  try {
    await writeFile(join(f.source, "README.md"), "target side\n");
    const target = await f.commit(); await f.push("target-side");
    const first = record(await (await f.prepare("refs/heads/target-side")).json());
    expect((await f.approve(text(first, "reviewId"))).status).toBe(201);
    expect((await f.post(`/reviews/${text(first, "reviewId")}/promotions`, { schemaVersion: 1 })).status).toBe(201);
    await git("/usr/bin/git", ["-C", f.source, "reset", "--hard", f.initial]);
    await writeFile(join(f.source, "feature.txt"), "source side\n");
    await git("/usr/bin/git", ["-C", f.source, "add", "feature.txt"]);
    const source = await f.commit(); await f.push("feature");
    const response = await f.prepare("refs/heads/feature"); expect(response.status, await response.clone().text()).toBe(200);
    const prepared = record(await response.json()), candidate = text(prepared, "candidateCommit");
    expect(candidate).not.toBe(source); expect(candidate).not.toBe(target);
    expect((await git("/usr/bin/git", ["--git-dir", f.repository, "rev-list", "--parents", "-n", "1", candidate])).stdout.trim()).toBe(`${candidate} ${target} ${source}`);
    expect((await git("/usr/bin/git", ["--git-dir", f.repository, "show", `${candidate}:README.md`])).stdout).toBe("target side\n");
    expect((await git("/usr/bin/git", ["--git-dir", f.repository, "show", `${candidate}:feature.txt`])).stdout).toBe("source side\n");
    expect(await (await f.prepare("refs/heads/feature")).json()).toEqual(prepared);
    expect(await f.head()).toBe(target);
    // Source already contained in the target needs neither a new proposal nor a write.
    expect(await (await f.prepare("refs/heads/target-side")).json()).toMatchObject({ outcome: "unchanged", sourceCommit: target });

    await git("/usr/bin/git", ["-C", f.source, "reset", "--hard", f.initial]);
    await writeFile(join(f.source, "README.md"), "conflicting source side\n");
    await f.commit(); await f.push("conflicting");
    const conflict = record(await (await f.prepare("refs/heads/conflicting")).json());
    expect(conflict.outcome).toBe("conflict"); expect(conflict.proposalRef).toBeUndefined();
    expect(await f.head()).toBe(target);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);

it("rejects reserved, revision-expression, missing, tag, symbolic and noncommit sources and unmanaged targets", async () => {
  const f = await ordinaryMergeFixture();
  try {
    await f.push("existing");
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    await git("/usr/bin/git", ["-C", f.source, "tag", "release"]);
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", "refs/tags/release"]);
    for (const ref of [f.proposalRef, "refs/heads/proposals", "refs/dim/internal", "refs/tags/release", "refs/heads/existing~1", "refs/heads/existing^{commit}", "refs/heads/existing..main", "refs/heads/missing", "refs/heads/bad.lock"]) {
      const response = await f.prepare(ref); expect(response.status, `${ref}: ${await response.clone().text()}`).toBe(409);
    }
    expect((await f.prepare("refs/heads/existing", "refs/heads/existing")).status).toBe(409);
    expect((await f.prepare("refs/heads/main", "refs/heads/existing")).status).toBe(409);
    await git("/usr/bin/git", ["--git-dir", f.repository, "symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
    expect((await f.prepare("refs/heads/alias")).status).toBe(409);
    await git("/usr/bin/git", ["--git-dir", f.repository, "symbolic-ref", "--delete", "refs/heads/alias"]);
    const blob = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", `${f.initial}:README.md`])).stdout.trim();
    await writeFile(join(f.repository, "refs/heads/not-a-commit"), `${blob}\n`);
    expect((await f.prepare("refs/heads/not-a-commit")).status).toBe(409);
    expect(await f.head()).toBe(f.initial);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);
