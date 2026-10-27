import { expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PullRequestPanel } from "@slop-lab/gs-react-pull-requests";
import { parsePullRequest } from "@slop-lab/gs-pull-requests";
import { parseGitDiff } from "@slop-lab/gs-diff";
const base = "a".repeat(40), head = "b".repeat(40), oldRevision = "a22b5dfc-9108-4f40-9684-e68cc7000001", revisionId = "a22b5dfc-9108-4f40-9684-e68cc7000002";
const pr = parsePullRequest({ schemaVersion: 1, id: "a22b5dfc-9108-4f40-9684-e68cc7000003", version: 2, title: "Portable change", body: "<script>unsafe()</script>", sourceRef: "refs/heads/feature/work", targetRef: "refs/heads/main", state: "open", actorId: "author", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  revisions: [{ id: oldRevision, sourceCommit: "c".repeat(40), targetCommit: base, createdAt: "2026-01-01T00:00:00.000Z" }, { id: revisionId, sourceCommit: head, targetCommit: base, createdAt: "2026-01-02T00:00:00.000Z" }],
  comments: [{ id: "a22b5dfc-9108-4f40-9684-e68cc7000004", revisionId: oldRevision, actorId: "reviewer", body: "Old anchored thread", createdAt: "2026-01-01T00:00:00.000Z", anchor: { path: "file", side: "head", line: 1 } }, { id: "a22b5dfc-9108-4f40-9684-e68cc7000005", revisionId, actorId: "reviewer", body: "Current anchored thread", createdAt: "2026-01-02T00:00:00.000Z", anchor: { path: "file", side: "head", line: 1 } }] });
const snapshot = parseGitDiff("diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n", { baseCommit: base, headCommit: head });
it("composes portable PR discussions and diff, labels old threads, escapes metadata and hides unavailable actions", () => {
  const html = renderToStaticMarkup(h(PullRequestPanel, { pullRequests: [pr], selected: pr, snapshot }));
  expect(html).not.toContain("style="); expect(html).toContain("git-pr__comment");
  expect(html).toContain("Outdated revision"); expect(html).toContain("Old anchored thread"); expect(html).toContain("Current anchored thread");
  expect(html).toContain('data-diff-below-line'); expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
  expect(html).not.toContain("<script>"); expect(html).not.toContain("Merge pull request"); expect(html).not.toContain("Post comment"); expect(html).not.toContain("Create pull request");
});
it("keeps review preparation, approval, revocation and merge as explicit independent actions", () => {
  const html = renderToStaticMarkup(h(PullRequestPanel, { pullRequests: [pr], selected: pr, snapshot: { ...snapshot, headCommit: "c".repeat(40) }, onComment() {}, onPrepareReview() {}, onApprove() {}, onRevoke() {}, onMerge() {}, approveDisabled: true, reviewContent: h("p", null, "Adapter review content") }));
  expect(html).toContain("Diff unavailable"); expect(html).not.toContain("data-git-diff");
  expect(html).toContain("Current anchored thread"); expect(html).toContain("Adapter review content"); expect(html).toContain("Approve revision"); expect(html).toContain("Merge pull request");
  expect(html).toContain("Prepare review"); expect(html).toContain("Revoke approval");
  expect(html).not.toContain("Select head line"); expect(html).toContain("Post comment");
});
it("shows clear empty and create states without any service or account setup", () => {
  const html = renderToStaticMarkup(h(PullRequestPanel, { pullRequests: [], selected: null, snapshot: null, onCreate() {} }));
  expect(html).toContain("No pull requests."); expect(html).toContain("Create pull request"); expect(html).toContain("Source branch"); expect(html).toContain("Target branch");
});

it("offers direct diff and blame inspection without requiring a pull request", () => {
  const html = renderToStaticMarkup(h(PullRequestPanel, {
    pullRequests: [], selected: null, snapshot: null,
    onInspectDiff: async () => snapshot,
    onInspectBlame: async () => ({ author: "Reviewer", summary: "Explain line", commit: head, path: "file", line: 1 })
  }));
  expect(html).toContain("Inspect commits");
  expect(html).toContain("Base commit");
  expect(html).toContain("Head commit");
  expect(html).toContain("Inspect diff");
  expect(html).toContain("Blame commit");
  expect(html).toContain("File path");
  expect(html).toContain("Inspect blame");
});

it("indexes comments once instead of scanning every comment for every diff line", () => {
  let revisionReads = 0;
  const comments = pr.comments.map(item => new Proxy(item, { get(target, key, receiver) { if (key === "revisionId") revisionReads++; return Reflect.get(target, key, receiver); } }));
  const manyLines = parseGitDiff(["diff --git a/file b/file", "--- a/file", "+++ b/file", "@@ -1,100 +1,100 @@", ...Array.from({ length: 100 }, () => " unchanged"), ""].join("\n"), { baseCommit: base, headCommit: head });
  const html = renderToStaticMarkup(h(PullRequestPanel, { pullRequests: [pr], selected: { ...pr, comments }, snapshot: manyLines }));
  expect(html).toContain("Current anchored thread"); expect(revisionReads).toBeLessThan(20);
});

it("uses supplied repository targets and controlled drafts without inventing a source branch", () => {
  const html = renderToStaticMarkup(h(PullRequestPanel, { pullRequests: [], selected: null, snapshot: null, onCreate() {}, createScopeKey: "project/private", createDraft: { title: "Merge feature", body: "", sourceRef: "development-tmp", targetRef: "refs/heads/release" }, targetRefs: ["refs/heads/release", "refs/heads/staging"] }));
  expect(html).toContain('value="development-tmp"');
  expect(html).toContain('<select'); expect(html).toContain('value="refs/heads/release" selected');
  expect(html).not.toContain('value="main"'); expect(html).not.toContain('value="development"');
});
