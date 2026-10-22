import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nativeRepositoryPolicyRevision } from "@slop-lab/dim-contracts-git";
import { reviewChangeMatcherExtension } from "@slop-lab/dim-control-plane-plugin-code-review/plugin-api";
import { controlPlanePlugin as mergePlugin } from "@slop-lab/dim-control-plane-plugin-merge-policy";
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
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);
