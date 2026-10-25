import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { commentIsOutdated } from "@slop-lab/git-discussions";
import { parsePullRequest, parsePullRequestList, currentRevision } from "@slop-lab/git-pull-requests";
import { controlPlanePlugin as pullRequests } from "../../../../packages/control-plane/plugins/git-pull-requests/src/index.js";
import { controlPlanePlugin as discussions } from "../../../../packages/control-plane/plugins/git-discussions/src/index.js";
import { controlPlanePlugin as diff } from "../../../../packages/control-plane/plugins/git-diff/src/index.js";
import { controlPlanePlugin as merge } from "@slop-lab/dim-control-plane-plugin-git-merge-policy";
import { configuredNativeGitBundleServer } from "@slop-lab/dim-control-plane-plugin-git-repositories";
import { fixture, git, basic, reviewer, token, generationId, record, text } from "../git-repositories/optionalFeaturesFixture.js";
const promoter = { hostId: "host-a", username: "promoter", password: token(10) };
const foreign = { reviewerId: "foreign", username: "foreign", password: token(11) };
const headers = (identity = reviewer, generation = generationId) => ({ authorization: basic(identity), "x-dim-generation-id": generation, "content-type": "application/json" });
async function setup(source: "proposal" | "branch" | "lightweight-tag" | "annotated-tag" = "proposal") {
  const prepared = await Promise.all([pullRequests.configure({}), discussions.configure({}), diff.configure({}), merge.configure({ hostPromoters: [promoter] })]);
  const f = await fixture(true, prepared.flatMap((plugin) => plugin.extensions ?? []), undefined, [reviewer, foreign]);
  try {
    await writeFile(join(f.source, "README.md"), "candidate line\n"); const candidate = await f.commit();
    const sourceRef = source === "proposal" ? f.proposalRef : source === "branch" ? "refs/heads/feature/review" : "refs/tags/review-candidate";
    if (source === "annotated-tag") {
      await git("/usr/bin/git", ["-C", f.source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "tag", "-a", "review-candidate", "-m", "Candidate snapshot"]);
    }
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", source === "annotated-tag" ? sourceRef : `HEAD:${sourceRef}`]);
    const endpoint = `${f.origin}/v1/projects/project/repositories/main/pull-requests`;
    const response = await fetch(endpoint, { method: "POST", headers: headers(), body: JSON.stringify({ title: "A real PR", body: "Review the source", sourceRef }) });
    expect(response.status, await response.clone().text()).toBe(201);
    return { ...f, endpoint, candidate, sourceRef, pr: parsePullRequest(await response.json()) };
  } catch (error) { await f.service.close(); await rm(f.root, { recursive: true, force: true }); throw error; }
}
it.each(["branch", "lightweight-tag", "annotated-tag"] as const)("reviews and promotes an ordinary %s source without inventing workspace provenance", { timeout: 30_000 }, async (source) => {
  // Given
  const f = await setup(source);
  try {
    // When
    const response = await fetch(`${f.endpoint}/${f.pr.id}/review`, { method: "POST", headers: headers(), body: JSON.stringify({ expectedVersion: f.pr.version }) });
    expect(response.status, await response.clone().text()).toBe(200);
    const evidence = record(record(await response.json()).review), review = record(evidence.review);
    const endpoint = `${f.origin}/v1/projects/project/repositories/main/reviews/${text(review, "reviewId")}`;
    const promote = () => fetch(`${endpoint}/promotions`, { method: "POST", headers: { ...headers(), authorization: basic(promoter) }, body: JSON.stringify({ schemaVersion: 1 }) });

    // Then
    expect(review.workspaceId).toBeUndefined();
    expect(review.proposalRef).toBe(f.sourceRef);
    expect((await promote()).status).toBe(409);
    expect((await fetch(`${endpoint}/approvals`, { method: "POST", headers: headers(), body: JSON.stringify({ requestId: randomUUID() }) })).status).toBe(201);
    const promoted = await promote();
    expect(promoted.status, await promoted.clone().text()).toBe(201);
    expect((await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(f.candidate);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
});
it("accepts an ordinary data tag as Git data but refuses to review it as a commit candidate", async () => {
  const f = await setup("branch");
  try {
    const blob = (await git("/usr/bin/git", ["-C", f.source, "rev-parse", "HEAD:README.md"])).stdout.trim();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `${blob}:refs/tags/data-object`]);
    const response = await fetch(f.endpoint, { method: "POST", headers: headers(), body: JSON.stringify({ title: "Not a commit", sourceRef: "refs/tags/data-object" }) });
    expect(response.status).toBe(409);
    expect((await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(f.initial);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
});
it("rejects using the protected target itself as a PR source before writing conversation or ref state", async () => {
  const f = await setup("branch");
  try {
    const response = await fetch(f.endpoint, { method: "POST", headers: headers(), body: JSON.stringify({ title: "Same ref", sourceRef: "refs/heads/main", targetRef: "refs/heads/main" }) });
    expect(response.status).toBe(409);
    expect(parsePullRequestList(await (await fetch(f.endpoint, { headers: headers() })).json())).toHaveLength(1);
    expect((await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(f.initial);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
});
it("keeps the protected head unchanged when an approved ordinary branch advances and the PR refreshes", { timeout: 30_000 }, async () => {
  // Given
  const f = await setup("branch");
  try {
    const reviewResponse = await fetch(`${f.endpoint}/${f.pr.id}/review`, { method: "POST", headers: headers(),
      body: JSON.stringify({ expectedVersion: f.pr.version }) });
    expect(reviewResponse.status).toBe(200);
    const reviewId = text(record(record(record(await reviewResponse.json()).review).review), "reviewId");
    const reviewEndpoint = `${f.origin}/v1/projects/project/repositories/main/reviews/${reviewId}`;
    expect((await fetch(`${reviewEndpoint}/approvals`, { method: "POST", headers: headers(),
      body: JSON.stringify({ requestId: randomUUID() }) })).status).toBe(201);
    await writeFile(join(f.source, "README.md"), "second ordinary candidate\n");
    await f.commit();

    // When
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.sourceRef}`]);
    const afterPush = (await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"),
      "rev-parse", "refs/heads/main"])).stdout.trim();
    const refreshed = await fetch(`${f.endpoint}/${f.pr.id}/refresh`, { method: "POST", headers: headers(),
      body: JSON.stringify({ expectedVersion: f.pr.version }) });

    // Then
    expect(afterPush).toBe(f.initial);
    expect(refreshed.status).toBe(200);
    expect((await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"),
      "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(f.initial);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
});
it("uses actual Git refs for stable PR revisions, discussions, review and protected promotion", { timeout: 30_000 }, async () => {
  const f = await setup();
  try {
    let pr = f.pr; const first = currentRevision(pr);
    const identity = await fetch(`${f.origin}/v1/human-reviewer-identity`, { headers: headers() });
    expect(record(await identity.json()).features).toEqual(["git-diff", "git-discussions", "git-pull-requests"]);
    const comment = await fetch(`${f.endpoint}/${pr.id}/comments`, { method: "POST", headers: headers(), body: JSON.stringify({ expectedVersion: pr.version, revisionId: first.id, body: "Why this line?", anchor: { path: "README.md", side: "head", line: 1 } }) });
    expect(comment.status, await comment.clone().text()).toBe(201); pr = parsePullRequest(await comment.json());
    const invalidAnchor = await fetch(`${f.endpoint}/${pr.id}/comments`, { method: "POST", headers: headers(), body: JSON.stringify({ expectedVersion: pr.version, revisionId: first.id, body: "Invalid line", anchor: { path: "README.md", side: "head", line: 999 } }) });
    expect(invalidAnchor.status).toBe(409);
    const reviewResponse = await fetch(`${f.endpoint}/${pr.id}/review`, { method: "POST", headers: headers(), body: JSON.stringify({ expectedVersion: pr.version }) });
    expect(reviewResponse.status, await reviewResponse.clone().text()).toBe(200);
    const reviewId = text(record(record(record(await reviewResponse.json()).review).review), "reviewId");
    const reviewEndpoint = `${f.origin}/v1/projects/project/repositories/main/reviews/${reviewId}`;
    expect((await fetch(`${reviewEndpoint}/promotions`, { method: "POST", headers: { ...headers(), authorization: basic(promoter) }, body: JSON.stringify({ schemaVersion: 1 }) })).status).toBe(409);
    expect((await fetch(`${reviewEndpoint}/approvals`, { method: "POST", headers: headers(), body: JSON.stringify({ requestId: randomUUID() }) })).status).toBe(201);
    // A new push must invalidate approval evidence rather than silently retarget it.
    await writeFile(join(f.source, "README.md"), "second candidate\n"); await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    expect((await fetch(`${f.endpoint}/${pr.id}/review`, { method: "POST", headers: headers(), body: JSON.stringify({ expectedVersion: pr.version }) })).status).toBe(409);
    expect((await fetch(`${reviewEndpoint}/promotions`, { method: "POST", headers: { ...headers(), authorization: basic(promoter) }, body: JSON.stringify({ schemaVersion: 1 }) })).status).toBe(409);
    const refreshed = await fetch(`${f.endpoint}/${pr.id}/refresh`, { method: "POST", headers: headers(), body: JSON.stringify({ expectedVersion: pr.version }) });
    expect(refreshed.status).toBe(200); pr = parsePullRequest(await refreshed.json());
    expect(pr.id).toBe(f.pr.id); expect(pr.revisions).toHaveLength(2); expect(commentIsOutdated(pr.comments[0]!, currentRevision(pr).id)).toBe(true);
    const newReview = await fetch(`${f.endpoint}/${pr.id}/review`, { method: "POST", headers: headers(), body: JSON.stringify({ expectedVersion: pr.version }) });
    expect(newReview.status, await newReview.clone().text()).toBe(200);
    const newReviewId = text(record(record(record(await newReview.json()).review).review), "reviewId");
    const newReviewEndpoint = `${f.origin}/v1/projects/project/repositories/main/reviews/${newReviewId}`;
    expect((await fetch(`${newReviewEndpoint}/approvals`, { method: "POST", headers: headers(), body: JSON.stringify({ requestId: randomUUID() }) })).status).toBe(201);
    expect((await fetch(`${newReviewEndpoint}/promotions`, { method: "POST", headers: { ...headers(), authorization: basic(promoter) }, body: JSON.stringify({ schemaVersion: 1 }) })).status).toBe(201);
    const merged = await fetch(`${f.endpoint}/${pr.id}/refresh`, { method: "POST", headers: headers(), body: JSON.stringify({ expectedVersion: pr.version }) });
    expect(merged.status, await merged.clone().text()).toBe(200); pr = parsePullRequest(await merged.json()); expect(pr.state).toBe("merged");
    expect((await fetch(`${f.endpoint}/${pr.id}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ expectedVersion: pr.version, state: "open" }) })).status).toBe(409);
  } finally { await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
});
it("rejects stale edits, cross-repository access, forged actors and preserves records after restart", { timeout: 30_000 }, async () => {
  const f = await setup();
  let restarted: Awaited<ReturnType<typeof configuredNativeGitBundleServer>> | undefined;
  try {
    const pr = f.pr;
    const replay = await fetch(f.endpoint, { method: "POST", headers: headers(), body: JSON.stringify({ title: pr.title, body: pr.body, sourceRef: pr.sourceRef, targetRef: pr.targetRef }) });
    expect(replay.status).toBe(200); expect(parsePullRequest(await replay.json()).id).toBe(pr.id);
    expect((await fetch(f.endpoint, { method: "POST", headers: headers(), body: JSON.stringify({ title: "Other duplicate", sourceRef: pr.sourceRef }) })).status).toBe(409);
    expect((await fetch(f.endpoint, { headers: headers(foreign) })).status).toBe(403);
    expect((await fetch(f.endpoint, { headers: headers(reviewer, "stale") })).status).toBe(409);
    expect((await fetch(f.endpoint.replace("repositories/main", "repositories/private"), { headers: headers() })).status).toBe(404);
    expect((await fetch(f.endpoint, { method: "POST", headers: headers(), body: JSON.stringify({ title: "Forged", sourceRef: f.proposalRef, actorId: "admin" }) })).status).toBe(400);
    const edits = await Promise.all(["one", "two"].map((title) => fetch(`${f.endpoint}/${pr.id}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ expectedVersion: pr.version, title }) })));
    expect(edits.map((response) => response.status).sort()).toEqual([200, 409]);
    await f.service.close(); restarted = await configuredNativeGitBundleServer(f.options); const origin = await restarted.listen("127.0.0.1", 0);
    const response = await fetch(`${origin}/v1/projects/project/repositories/main/pull-requests`, { headers: headers() });
    expect(response.status, await response.clone().text()).toBe(200); const records = parsePullRequestList(await response.json()); expect(records).toHaveLength(1); expect(records[0]?.id).toBe(pr.id); expect(records[0]?.version).toBe(2);
  } finally { await restarted?.close(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
});
it("preserves rewritten source history, repairs an interrupted pin and rejects unowned or mismatched refs", { timeout: 30_000 }, async () => {
  const f = await setup("branch");
  let restarted: Awaited<ReturnType<typeof configuredNativeGitBundleServer>> | undefined;
  try {
    const first = currentRevision(f.pr);
    const pinnedRef = `refs/dim/extensions/git-pull-requests/${f.pr.id}/revisions/${first.id}/head`;
    await expect(git("/usr/bin/git", ["-C", f.source, "push", "origin", "HEAD:refs/dim/extensions/git-pull-requests/attacker/head"])).rejects.toThrow();
    await git("/usr/bin/git", ["-C", f.source, "reset", "--hard", f.initial]);
    await writeFile(join(f.source, "README.md"), "divergent replacement\n"); await f.commit();
    const repository = join(f.root, "state/project/main.git");
    await git("/usr/bin/git", ["-C", f.source, "push", "--force", "origin", `HEAD:${f.sourceRef}`]);
    const refreshed = await fetch(`${f.endpoint}/${f.pr.id}/refresh`, { method: "POST", headers: headers(), body: JSON.stringify({ expectedVersion: f.pr.version }) });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    const oldDiff = await fetch(`${f.origin}/v1/projects/project/repositories/main/diff`, { method: "POST", headers: headers(), body: JSON.stringify({ baseCommit: first.targetCommit, headCommit: first.sourceCommit }) });
    expect(oldDiff.status, await oldDiff.clone().text()).toBe(200);
    await f.service.close();
    // Simulate interruption after the durable owner record but before a pin write.
    await git("/usr/bin/git", ["--git-dir", repository, "update-ref", "-d", pinnedRef]);
    restarted = await configuredNativeGitBundleServer(f.options); const origin = await restarted.listen("127.0.0.1", 0);
    expect((await git("/usr/bin/git", ["--git-dir", repository, "rev-parse", pinnedRef])).stdout.trim()).toBe(first.sourceCommit);
    const endpoint = `${origin}/v1/projects/project/repositories/main/pull-requests`;
    const unknown = "refs/dim/extensions/git-pull-requests/unowned/head";
    await git("/usr/bin/git", ["--git-dir", repository, "update-ref", unknown, first.sourceCommit]);
    expect((await fetch(endpoint, { headers: headers() })).status).toBe(404);
    await git("/usr/bin/git", ["--git-dir", repository, "update-ref", "-d", unknown]);
    await git("/usr/bin/git", ["--git-dir", repository, "update-ref", pinnedRef, first.targetCommit]);
    expect((await fetch(endpoint, { headers: headers() })).status).toBe(404);
    await git("/usr/bin/git", ["--git-dir", repository, "update-ref", pinnedRef, first.sourceCommit]);
    expect((await fetch(endpoint, { headers: headers() })).status).toBe(200);
  } finally { await restarted?.close(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); }
});
