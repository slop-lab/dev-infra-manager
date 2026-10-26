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
