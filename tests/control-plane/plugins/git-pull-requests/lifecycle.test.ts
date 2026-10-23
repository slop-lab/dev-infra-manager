import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parsePullRequest, parsePullRequestList, currentRevision, commentIsOutdated } from "@slop-lab/git-pull-requests";
import { controlPlanePlugin as pullRequests } from "../../../../packages/control-plane/plugins/git-pull-requests/src/index.js";
import { controlPlanePlugin as discussions } from "../../../../packages/control-plane/plugins/git-discussions/src/index.js";
import { controlPlanePlugin as diff } from "../../../../packages/control-plane/plugins/git-diff/src/index.js";
import { controlPlanePlugin as merge } from "@slop-lab/dim-control-plane-plugin-git-merge-policy";
import { configuredNativeGitBundleServer } from "@slop-lab/dim-control-plane-plugin-git-repositories";
import { fixture, git, basic, reviewer, token, generationId, record, text } from "../git-repositories/optionalFeaturesFixture.js";
const promoter = { hostId: "host-a", username: "promoter", password: token(10) };
const foreign = { reviewerId: "foreign", username: "foreign", password: token(11) };
const headers = (identity = reviewer, generation = generationId) => ({ authorization: basic(identity), "x-dim-generation-id": generation, "content-type": "application/json" });
async function setup() {
  const prepared = await Promise.all([pullRequests.configure({}), discussions.configure({}), diff.configure({}), merge.configure({ hostPromoters: [promoter] })]);
  const f = await fixture(true, prepared.flatMap((plugin) => plugin.extensions ?? []), undefined, [reviewer, foreign]);
  try {
    await writeFile(join(f.source, "README.md"), "candidate line\n"); const candidate = await f.commit();
    await git("/usr/bin/git", ["-C", f.source, "push", "origin", `HEAD:${f.proposalRef}`]);
    const endpoint = `${f.origin}/v1/projects/project/repositories/main/pull-requests`;
    const response = await fetch(endpoint, { method: "POST", headers: headers(), body: JSON.stringify({ title: "A real PR", body: "Review the source", sourceRef: f.proposalRef }) });
    expect(response.status, await response.clone().text()).toBe(201);
    return { ...f, endpoint, candidate, pr: parsePullRequest(await response.json()) };
  } catch (error) { await f.service.close(); await rm(f.root, { recursive: true, force: true }); throw error; }
}
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
    expect(pr.id).toBe(f.pr.id); expect(pr.revisions).toHaveLength(2); expect(commentIsOutdated(pr, pr.comments[0]!)).toBe(true);
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
  const f = await setup();
  let restarted: Awaited<ReturnType<typeof configuredNativeGitBundleServer>> | undefined;
  try {
    const first = currentRevision(f.pr);
    const pinnedRef = `refs/dim/extensions/git-pull-requests/${f.pr.id}/revisions/${first.id}/head`;
    // Workspace receive authority remains exactly its proposal namespace.
    await expect(git("/usr/bin/git", ["-C", f.source, "push", "origin", "HEAD:refs/dim/extensions/git-pull-requests/attacker/head"])).rejects.toThrow();
    await git("/usr/bin/git", ["-C", f.source, "reset", "--hard", f.initial]);
    await writeFile(join(f.source, "README.md"), "divergent replacement\n"); await f.commit();
    // Current receive policy rejects workspace force pushes. Simulate a
    // trusted operator source-ref rewrite to exercise retained old history.
    const repository = join(f.root, "state/project/main.git");
    await git("/usr/bin/git", ["--git-dir", repository, "fetch", f.source, "HEAD"]);
    await git("/usr/bin/git", ["--git-dir", repository, "update-ref", f.proposalRef, "FETCH_HEAD"]);
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
