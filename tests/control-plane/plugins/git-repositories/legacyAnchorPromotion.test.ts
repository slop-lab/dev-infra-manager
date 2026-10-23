import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nativeRepositoryPolicyRevision } from "@slop-lab/dim-contracts-git";
import { controlPlanePlugin as mergePlugin } from "@slop-lab/dim-control-plane-plugin-git-merge-policy";
import { readNativeProjectRootCurrentHeadFromDatabase } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { basic, fixture, generationId, git, record, reviewer, text, token } from "./optionalFeaturesFixture.js";
it("promotes development after five legacy anchor transitions and adding default main without rewriting the import", async () => {
  const promoter = { hostId: "host-a", username: "promoter", password: token(10) };
  const merge = await mergePlugin.configure({ hostPromoters: [promoter] });
  const reviewPolicy = { requiredReviewerIds: [], pathReviewerRules: [{ pathPrefix: ".dim/", reviewerIds: ["owner"] }] };
  const f = await fixture(true, merge.extensions ?? [], reviewPolicy, [reviewer], { "merge-policy": {} }, undefined, "refs/heads/development");
  const headers = (credential: { username: string; password: string }) => ({ authorization: basic(credential), "x-dim-generation-id": generationId, "content-type": "application/json" });
  const base = `${f.origin}/v1/projects/project/repositories/main`;
  const post = (suffix: string, body: unknown, credential: { username: string; password: string } = reviewer) => fetch(base + suffix, { method: "POST", headers: headers(credential), body: JSON.stringify(body) });
  const promote = async (content: string) => {
    await writeFile(join(f.source, "README.md"), content);
    const commit = await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    const response = await post("/reviews/resolve", { schemaVersion: 1, proposalRef: f.proposalRef, protectedRef: "refs/heads/development" });
    expect(response.status, await response.clone().text()).toBe(200);
    const review = record(record(await response.json()).review);
    expect(review.requiredReviewerIds).toEqual([]);
    const promoted = await post(`/reviews/${text(review, "reviewId")}/promotions`, { schemaVersion: 1 }, promoter);
    expect(promoted.status, await promoted.clone().text()).toBe(201);
    return commit;
  };
  try {
    let commit = f.initial;
    for (let i = 1; i <= 5; i++) commit = await promote(`legacy ${i}\n`);
    const importer = { username: "importer", password: token(1) };
    const previousResponse = await fetch(base + "/policy", { headers: headers(importer) });
    expect(previousResponse.status).toBe(200);
    const previous = record(await previousResponse.json());
    const body = { protectedRef: "refs/heads/development", defaultRef: "refs/heads/main", branches: { "refs/heads/main": { review: true }, "refs/heads/development": { review: false } }, extensions: { "code-review": reviewPolicy, "merge-policy": {} } };
    const updated = await post("/policy", { schemaVersion: 1, expectedPolicyDigest: previous.policyDigest, expectedProtectedHead: commit, policy: { schemaVersion: 1, ...body, policyRevision: nativeRepositoryPolicyRevision(body) } }, importer);
    expect(updated.status, await updated.clone().text()).toBe(200);
    const database = f.service.context.runtime.state.database;
    expect(readNativeProjectRootCurrentHeadFromDatabase(database, "project", "main", "refs/heads/main")).toMatchObject({ commit, sequence: 5 });
    const next = await promote("new development after default main\n");
    expect(readNativeProjectRootCurrentHeadFromDatabase(database, "project", "main", "refs/heads/development")).toMatchObject({ commit: next, sequence: 6 });
    expect(readNativeProjectRootCurrentHeadFromDatabase(database, "project", "main", "refs/heads/main")).toMatchObject({ commit, sequence: 6 });
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000);
